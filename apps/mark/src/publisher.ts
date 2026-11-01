import type { Logger } from 'pino';
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import { acquireLease, type Db } from '@plankton/db';
import {
  chainTimeSec,
  exchangeAbi,
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
 * Turns mark decisions into oracle transactions, spending gas only when a price is needed (Float's rule):
 * - On schedule, only for markets where someone holds a position (exits and liquidations need a live price), on a
 *   price move above 10 bps, a status change, or a 120 s heartbeat (the contract accepts marks up to 180 s old).
 * - On demand, right before the API quotes a trade (`ensureFresh`), so an idle market costs nothing.
 * - Asks one signer first; asks the second only when the contract demands a quorum (out-of-band mark).
 * - Submits without waiting for receipts, so a slow block never delays the next mark.
 */
export class Publisher implements MarkSink {
  private readonly wallet: ReturnType<typeof createChainWallet>;
  private readonly last = new Map<string, { priceE18: bigint; at: number; status: Status }>();
  private readonly sequence = new Map<Hex, bigint>();
  private readonly busy = new Set<string>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private exposed = new Set<string>();
  private exposureAt = 0;
  private leaderUntil = 0;

  constructor(private readonly d: PublisherDeps) {
    this.wallet = createChainWallet(d.rpcUrls, d.privateKey);
    d.log.info({ publisher: this.wallet.account.address, signers: d.signerUrls.length }, 'publisher ready');
  }

  async onDecision(symbol: string, decision: MarkDecision, now: number): Promise<void> {
    if (this.busy.has(symbol)) return;
    const prev = this.last.get(symbol) ?? null;
    if (!(await this.hasExposure(symbol, now))) return; // no position open: published on demand instead
    if (!shouldPublish(prev, { priceE18: decision.priceE18, status: decision.status }, now, { republishBps: 10, heartbeatMs: 120_000 })) return;
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

  /**
   * Called by the API right before it quotes a trade. Publishes the current decision and waits for it to land, unless
   * the on-chain mark is already current (under 60 s old, same status, within 10 bps). Concurrent calls share one publish.
   * Returns true when it published.
   */
  async ensureFresh(symbol: string, decision: MarkDecision): Promise<boolean> {
    const running = this.inFlight.get(symbol);
    if (running) return running;
    const task = this.ensureFreshInner(symbol, decision).finally(() => this.inFlight.delete(symbol));
    this.inFlight.set(symbol, task);
    return task;
  }

  private async ensureFreshInner(symbol: string, decision: MarkDecision): Promise<boolean> {
    const marketId = this.d.markets.get(symbol);
    if (!marketId) throw new Error('unknown market');
    const [mark, nowSec] = await Promise.all([
      this.d.client.readContract({ address: this.d.dep.oracle, abi: oracleAbi, functionName: 'markOf', args: [marketId] }),
      chainTimeSec(this.d.client),
    ]);
    const current =
      mark.priceE18 > 0n &&
      nowSec - BigInt(mark.updatedAt) <= 60n &&
      mark.status === decision.status &&
      !shouldPublish({ priceE18: mark.priceE18, at: Date.now(), status: mark.status as Status }, decision, Date.now(), {
        republishBps: 10,
        heartbeatMs: Number.MAX_SAFE_INTEGER,
      });
    if (current) return false;
    if (!(await this.isLeader(Date.now()))) return false;
    while (this.busy.has(symbol)) await new Promise((res) => setTimeout(res, 100));
    this.busy.add(symbol);
    try {
      await this.publish(symbol, decision, Date.now(), true);
      return true;
    } finally {
      this.busy.delete(symbol);
    }
  }

  /** Markets with an open position, from the Exchange, refreshed at most every 10 s. */
  private async hasExposure(symbol: string, now: number): Promise<boolean> {
    if (now - this.exposureAt > 10_000) {
      this.exposureAt = now;
      const entries = [...this.d.markets.entries()];
      const infos = await this.d.client.multicall({
        allowFailure: true,
        contracts: entries.map(([, id]) => ({ address: this.d.dep.exchange, abi: exchangeAbi, functionName: 'marketInfo' as const, args: [id] })),
      });
      const next = new Set<string>();
      infos.forEach((r, i) => {
        // On a failed read, assume a position may be open: a missing mark can trap an exit, an extra one only costs gas.
        if (r.status !== 'success' || r.result[2] !== 0n || r.result[3] !== 0n) next.add(entries[i]![0]);
      });
      this.exposed = next;
    }
    return this.exposed.has(symbol);
  }

  private async isLeader(now: number): Promise<boolean> {
    if (!this.d.db) return true;
    if (now < this.leaderUntil) return true;
    const ok = await acquireLease(this.d.db, 'mark-publisher', this.d.holder, 30);
    if (ok) this.leaderUntil = now + 10_000; // re-check the lease every 10 s
    return ok;
  }

  private async publish(symbol: string, decision: MarkDecision, nowMs: number, wait = false): Promise<void> {
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

    // Scheduled publishes do not block on the receipt; an on-demand one (`wait`) does, so the quote that follows sees it.
    const landed = this.d.client
      .waitForTransactionReceipt({ hash, timeout: 60_000 })
      .then((r) => {
        if (r.status === 'success') return true;
        this.sequence.delete(marketId);
        this.d.log.error({ symbol, hash }, 'publish transaction reverted');
        return false;
      })
      .catch((err) => {
        this.sequence.delete(marketId);
        this.d.log.warn({ symbol, hash, err: describe(err) }, 'no receipt for publish');
        return false;
      });
    if (wait) await landed;
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
