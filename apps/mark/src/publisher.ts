import type { Logger } from 'pino';
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import { acquireLease, type Db } from '@plankton/db';
import {
  chainTimeSec,
  createChainWallet,
  oracleAbi,
  writeWithGasMargin,
  signature as signatureSchema,
  toJson,
  wire,
  type AttestationMsg,
  type ChainClient,
  type Deployment,
} from '@plankton/chain';
import { shouldPublish, type MarkDecision, type Status } from '@plankton/core';
import { z } from 'zod';
import type { MarkSink } from './runner.ts';

const signResponse = z.object({ signature: signatureSchema, signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

export interface PublisherDeps {
  log: Logger;
  client: ChainClient;
  rpcUrls: string[];
  dep: Deployment;
  privateKey: `0x${string}`;
  /** symbol -> marketId */
  markets: Map<string, Hex>;
  signerUrls: string[];
  signerToken: string;
  /** When present, only the lease holder publishes (one active publisher plus a hot standby). */
  db?: Db;
  holder: string;
}

/**
 * Turns mark decisions into oracle transactions.
 * - Publishes on a price move above 10 bps, a status change, or a 60 s heartbeat.
 * - Asks one signer first; asks the second only when the contract demands a quorum (out-of-band mark).
 * - Submits without waiting for receipts, so a slow block never delays the next mark.
 */
export class Publisher implements MarkSink {
  private readonly wallet: ReturnType<typeof createChainWallet>;
  private readonly last = new Map<string, { priceE18: bigint; at: number; status: Status }>();
  private readonly sequence = new Map<Hex, bigint>();
  private readonly busy = new Set<string>();
  private leaderUntil = 0;

  constructor(private readonly d: PublisherDeps) {
    this.wallet = createChainWallet(d.rpcUrls, d.privateKey);
    d.log.info({ publisher: this.wallet.account.address, signers: d.signerUrls.length }, 'publisher ready');
  }

  async onDecision(symbol: string, decision: MarkDecision, now: number): Promise<void> {
    if (this.busy.has(symbol)) return;
    const prev = this.last.get(symbol) ?? null;
    if (!shouldPublish(prev, { priceE18: decision.priceE18, status: decision.status }, now, { republishBps: 10, heartbeatMs: 60_000 })) return;
    if (!(await this.isLeader(now))) return;

    this.busy.add(symbol);
    try {
      await this.publish(symbol, decision, now);
    } catch (err) {
      this.d.log.warn({ symbol, revert: revertName(err), err: describe(err), details: err instanceof BaseError ? err.details : undefined }, 'publish failed');
    } finally {
      this.busy.delete(symbol);
    }
  }

  private async isLeader(now: number): Promise<boolean> {
    if (!this.d.db) return true;
    if (now < this.leaderUntil) return true;
    const ok = await acquireLease(this.d.db, 'mark-publisher', this.d.holder, 30);
    if (ok) this.leaderUntil = now + 10_000; // re-check the lease every 10 s
    return ok;
  }

  private async publish(symbol: string, decision: MarkDecision, nowMs: number): Promise<void> {
    const marketId = this.d.markets.get(symbol);
    if (!marketId) return;

    let last = this.sequence.get(marketId);
    if (last === undefined) {
      last = (await this.d.client.readContract({ address: this.d.dep.oracle, abi: oracleAbi, functionName: 'markOf', args: [marketId] })).sequence;
    }
    const sequence = last + 1n;
    const nowSec = await chainTimeSec(this.d.client); // the contract checks deadlines against block time
    const a: AttestationMsg = {
      marketId,
      markE18: decision.priceE18,
      refCloseE18: decision.refCloseE18,
      confidenceBps: decision.confidenceBps,
      status: decision.status,
      sequence,
      observedAt: nowSec,
      expiry: nowSec + 120n,
    };

    const sigs = [await this.sign(a, this.d.signerUrls[0]!)];
    // Once any signer has signed this sequence it will refuse it again, so move on even if the publish fails below.
    // Gaps in the sequence are harmless: the oracle only requires that it increases.
    this.sequence.set(marketId, sequence);
    let simulated = await this.simulate(a, sigs);
    if (simulated === 'quorum' && this.d.signerUrls.length > 1) {
      sigs.push(await this.sign(a, this.d.signerUrls[1]!));
      simulated = await this.simulate(a, sigs);
    }
    if (simulated === 'stale-sequence') {
      this.sequence.delete(marketId); // resync from the chain next tick
      return;
    }
    if (simulated !== 'ok') {
      this.d.log.warn({ symbol, reason: simulated }, 'oracle would reject this mark');
      return;
    }

    const hash = await writeWithGasMargin(this.d.client, this.wallet, {
      address: this.d.dep.oracle,
      abi: oracleAbi,
      functionName: 'publish',
      args: [{ ...a, status: a.status }, sortBySigner(sigs)],
    });
    this.sequence.set(marketId, sequence);
    this.last.set(symbol, { priceE18: decision.priceE18, at: nowMs, status: decision.status });

    // Do not block on the receipt. Log a revert if one shows up.
    void this.d.client
      .waitForTransactionReceipt({ hash, timeout: 60_000 })
      .then((r) => {
        if (r.status !== 'success') {
          this.sequence.delete(marketId);
          this.d.log.error({ symbol, hash }, 'publish transaction reverted');
        }
      })
      .catch((err) => {
        this.sequence.delete(marketId);
        this.d.log.warn({ symbol, hash, err: describe(err) }, 'no receipt for publish');
      });
  }

  private async sign(a: AttestationMsg, url: string): Promise<{ signature: Hex; signer: Address }> {
    const res = await fetch(`${url}/sign/mark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.d.signerToken}` },
      body: toJson(wire(a)),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`signer ${url} refused: HTTP ${res.status} ${await res.text()}`);
    const parsed = signResponse.parse(await res.json());
    return { signature: parsed.signature, signer: parsed.signer as Address };
  }

  private async simulate(a: AttestationMsg, sigs: Array<{ signature: Hex; signer: Address }>): Promise<string> {
    try {
      await this.d.client.simulateContract({
        account: this.wallet.account,
        address: this.d.dep.oracle,
        abi: oracleAbi,
        functionName: 'publish',
        args: [{ ...a, status: a.status }, sortBySigner(sigs)],
      });
      return 'ok';
    } catch (err) {
      const name = revertName(err);
      if (name === 'QuorumRequired') return 'quorum';
      if (name === 'StaleSequence') return 'stale-sequence';
      return name ?? describe(err);
    }
  }
}

/** The oracle needs signatures in ascending signer-address order (that also rules out duplicates). */
const sortBySigner = (sigs: Array<{ signature: Hex; signer: Address }>): Hex[] =>
  [...sigs].sort((x, y) => (BigInt(x.signer) < BigInt(y.signer) ? -1 : 1)).map((s) => s.signature);

function revertName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName;
  }
  return undefined;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0]! : String(err));
