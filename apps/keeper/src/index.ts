import { hostname } from 'node:os';
import { Hono } from 'hono';
import pino from 'pino';
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { loadDeployment, loadEnv, loadMarkets, need, requireDatabaseUrl } from '@plankton/config';
import {
  chainTimeSec,
  createChainClient,
  createChainWallet,
  exchangeAbi,
  marketIdFor,
  oracleAbi,
  orderWire,
  quoteWire,
  signature,
  toJson,
  vaultAbi,
  writeWithGasMargin,
} from '@plankton/chain';
import { closeSizeDeltaE18, isLiquidatable } from '@plankton/core';
import { acquireLease, and, createDb, eq, lt, orders, positions } from '@plankton/db';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const { markets } = loadMarkets();
const dep = loadDeployment();
const client = createChainClient(env.RPC_URLS);
const { account, wallet } = createChainWallet(env.RPC_URLS, need(env.KEEPER_PRIVATE_KEY, 'KEEPER_PRIVATE_KEY') as `0x${string}`);
const { db } = createDb(requireDatabaseUrl(env), { max: 4 });
// Every send carries a gas margin: nested library calls can make a bare estimate fall short.
const send = (req: Parameters<typeof wallet.writeContract>[0]) => writeWithGasMargin(client, { account, wallet }, req);
const holder = `${hostname()}-${process.pid}`;

const marketOf = new Map(markets.map((m) => [marketIdFor(m.symbol, m.stockToken as Address).toLowerCase(), m]));
const ids = [...marketOf.keys()] as Hex[];
const nowSec = () => Math.floor(Date.now() / 1000);

// Two keepers can run side by side: each task takes a short DB lease first, so only one sends at a time.
const isLeader = (task: string) => acquireLease(db, `keeper-${task}`, holder, 20);

const revertName = (err: unknown): string | undefined => {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName;
  }
  return undefined;
};
const msg = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0]! : String(err));

// The keeper's own calls to the API skip the public rate limit when INTERNAL_API_TOKEN is set on both sides.
const apiHeaders: Record<string, string> = { 'content-type': 'application/json', ...(env.INTERNAL_API_TOKEN ? { 'x-internal-token': env.INTERNAL_API_TOKEN } : {}) };

/** Drops expired cooldown entries so the maps cannot grow forever. */
function pruneCooldowns(now: number): void {
  for (const m of [cooldown, orderCooldown]) for (const [k, until] of m) if (until <= now) m.delete(k);
}

const health = { liquidate: 0, orders: 0, settle: 0, probe: 0, quoteServiceDownSince: null as number | null, sent: 0 };

/** Run `fn` every `ms`, never overlapping itself, never throwing. */
function every(name: string, ms: number, fn: () => Promise<void>): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.warn({ task: name, err: msg(err) }, 'task failed');
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(run, ms);
}

// ---------------------------------------------------------------- liquidations

const cooldown = new Map<string, number>();
const COOLDOWN_MS = 30_000;

async function liquidations(): Promise<void> {
  if (!(await isLeader('liquidate'))) return;
  const now = Date.now();
  const marks = await client.multicall({
    allowFailure: false,
    contracts: ids.map((id) => ({ address: dep.oracle, abi: oracleAbi, functionName: 'markOf' as const, args: [id] as const })),
  });
  const cfgs = await client.multicall({
    allowFailure: false,
    contracts: ids.map((id) => ({ address: dep.exchange, abi: exchangeAbi, functionName: 'configOf' as const, args: [id] as const })),
  });

  for (let i = 0; i < ids.length; i++) {
    const mark = marks[i]!;
    const cfg = cfgs[i]!;
    if (mark.priceE18 === 0n || mark.breaker) continue;
    const rows = await db.select().from(positions).where(eq(positions.marketId, ids[i]!));
    for (const r of rows) {
      const pos = { sizeE18: BigInt(r.sizeE18), entryE18: BigInt(r.entryE18), marginUsdg: BigInt(r.marginUsdg) };
      // Pre-filter with a 10% wider margin: the chain also counts borrow, so it is the real judge via simulation.
      if (!isLiquidatable(pos, mark.priceE18, { maintenanceMarginBps: Math.ceil(cfg.maintenanceMarginBps * 1.1) })) continue;
      const key = `${r.trader}:${r.marketId}`;
      if ((cooldown.get(key) ?? 0) > now) continue;
      cooldown.set(key, now + COOLDOWN_MS);
      try {
        await client.simulateContract({ account, address: dep.exchange, abi: exchangeAbi, functionName: 'liquidate', args: [r.trader as Address, ids[i]!] });
        const hash = await send({ address: dep.exchange, abi: exchangeAbi, functionName: 'liquidate', args: [r.trader as Address, ids[i]!] });
        health.sent++;
        log.info({ trader: r.trader, market: marketOf.get(ids[i]!)?.symbol, hash }, 'liquidation sent');
      } catch (err) {
        const name = revertName(err);
        // Not liquidatable yet, or the mark/Chainlink disagree: normal, wait for the next tick.
        if (name !== 'NotLiquidatable' && name !== 'LiquidationBlocked') log.warn({ trader: r.trader, err: name ?? msg(err) }, 'liquidation failed');
      }
    }
  }
  health.liquidate = now;
}

// ---------------------------------------------------------------- trigger orders

const quoteResponse = z.object({ quote: quoteWire, signature });
const orderCooldown = new Map<string, number>();

async function triggerOrders(): Promise<void> {
  if (!(await isLeader('orders'))) return;
  const now = Date.now();
  // Order times (validAfter, expiry) are block times, because the contract checks them against block.timestamp.
  const chainNowMs = Number(await chainTimeSec(client)) * 1000;
  await db.update(orders).set({ status: 'expired' }).where(and(eq(orders.status, 'open'), lt(orders.expiry, new Date(chainNowMs))));

  const open = await db.select().from(orders).where(eq(orders.status, 'open'));
  if (open.length === 0) {
    health.orders = now;
    return;
  }
  const markByMarket = new Map<string, bigint>();
  const marks = await client.multicall({
    allowFailure: false,
    contracts: ids.map((id) => ({ address: dep.oracle, abi: oracleAbi, functionName: 'markOf' as const, args: [id] as const })),
  });
  ids.forEach((id, i) => markByMarket.set(id, marks[i]!.priceE18));

  for (const row of open) {
    const mark = markByMarket.get(row.marketId) ?? 0n;
    const m = marketOf.get(row.marketId);
    if (!m || mark === 0n || row.validAfter.getTime() > chainNowMs) continue;
    const trigger = BigInt(row.triggerE18);
    const fires = row.kind === 4 || trigger === 0n ? true : row.triggerAbove ? mark >= trigger : mark <= trigger;
    if (!fires) continue;
    const key = `${row.trader}:${row.nonce}`;
    if ((orderCooldown.get(key) ?? 0) > now) continue;
    orderCooldown.set(key, now + 5_000);

    try {
      const order = orderWire.parse(row.body);
      let sizeDelta = order.sizeDeltaE18;
      if (order.sizeBps > 0) {
        const pos = await client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'positionOf', args: [order.trader, order.marketId] });
        sizeDelta = closeSizeDeltaE18(pos.size, order.sizeBps);
      }
      const res = await fetch(`${env.API_URL}/v1/quote/trade`, {
        method: 'POST',
        headers: apiHeaders,
        body: toJson({ market: m.symbol, trader: order.trader, sizeDeltaE18: sizeDelta, marginUsdg: order.marginUsdg }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue; // quote refused (e.g. session closed): leave the order open and retry
      const { quote, signature: quoteSig } = quoteResponse.parse(await res.json());

      const args = [order, row.sig as Hex, quote, quoteSig] as const;
      await client.simulateContract({ account, address: dep.exchange, abi: exchangeAbi, functionName: 'executeOrder', args });
      const hash = await send({ address: dep.exchange, abi: exchangeAbi, functionName: 'executeOrder', args });
      await db.update(orders).set({ status: 'filled', fillTx: hash }).where(and(eq(orders.trader, row.trader), eq(orders.nonce, row.nonce)));
      health.sent++;
      log.info({ trader: row.trader, nonce: row.nonce.toString(), market: m.symbol, hash }, 'order executed');
    } catch (err) {
      const name = revertName(err);
      // Terminal: the order can never execute. Anything else (trigger, slippage, stale mark) just waits.
      if (name === 'NonceUsed' || name === 'OrderNotActive') {
        await db.update(orders).set({ status: name === 'OrderNotActive' ? 'expired' : 'cancelled', failReason: name }).where(and(eq(orders.trader, row.trader), eq(orders.nonce, row.nonce)));
      } else if (name === 'InsufficientCollateral') {
        // Entry collateral is checked when the order is submitted and reserved against other open entries. If it is
        // later withdrawn or consumed, this signed order can no longer fill; stop retrying it every keeper tick.
        await db.update(orders).set({ status: 'failed', failReason: name }).where(and(eq(orders.trader, row.trader), eq(orders.nonce, row.nonce), eq(orders.status, 'open')));
      } else if (name === 'BadSigner' || name === 'OrderMismatch' || name === 'NotReducing') {
        await db.update(orders).set({ status: 'failed', failReason: name }).where(and(eq(orders.trader, row.trader), eq(orders.nonce, row.nonce)));
      } else {
        log.debug({ trader: row.trader, nonce: row.nonce.toString(), reason: name ?? msg(err) }, 'order not executed');
      }
    }
  }
  health.orders = now;
}

// ---------------------------------------------------------------- Counter settlement

const pendingRequests = new Set<bigint>();
let scannedUpTo = 0n;

async function settleCounter(): Promise<void> {
  const next = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'nextRequestId' });
  const newIds: bigint[] = [];
  for (let id = scannedUpTo + 1n; id < next; id++) newIds.push(id);
  scannedUpTo = next - 1n < 0n ? 0n : next - 1n;
  for (const id of newIds) pendingRequests.add(id);

  if (pendingRequests.size > 0) {
    const list = [...pendingRequests];
    const reqs = await client.multicall({
      allowFailure: false,
      contracts: list.map((id) => ({ address: dep.vault, abi: vaultAbi, functionName: 'requests' as const, args: [id] as const })),
    });
    list.forEach((id, i) => {
      if (reqs[i]![2]) pendingRequests.delete(id); // index 2 is `done`
    });
  }
  health.settle = Date.now();
  if (pendingRequests.size === 0 || !(await isLeader('settle'))) return;

  try {
    await client.simulateContract({ account, address: dep.vault, abi: vaultAbi, functionName: 'settle', args: [50n] });
    const hash = await send({ address: dep.vault, abi: vaultAbi, functionName: 'settle', args: [50n] });
    health.sent++;
    log.info({ pending: pendingRequests.size, hash }, 'settle sent');
  } catch (err) {
    log.warn({ err: revertName(err) ?? msg(err) }, 'settle failed');
  }
}

// ---------------------------------------------------------------- quote service watchdog

/**
 * Asks the API for a tiny quote once a minute. A refusal (HTTP 422) means the service is alive; only silence or a 5xx
 * counts as down. After 10 minutes down it shouts, because users must then rely on closeAtMark.
 */
async function probeQuoteService(): Promise<void> {
  const m = markets[0];
  if (!m) return;
  let alive = false;
  try {
    const res = await fetch(`${env.API_URL}/v1/quote/trade`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({ market: m.symbol, trader: account.address, sizeDeltaE18: '1000000000000', marginUsdg: '1000000' }),
      signal: AbortSignal.timeout(8_000),
    });
    alive = res.status < 500;
  } catch {
    alive = false;
  }
  const now = Date.now();
  health.probe = now;
  if (alive) {
    if (health.quoteServiceDownSince) log.info('quote service is back');
    health.quoteServiceDownSince = null;
    return;
  }
  health.quoteServiceDownSince ??= now;
  if (now - health.quoteServiceDownSince >= 10 * 60_000) {
    log.error({ downMinutes: Math.floor((now - health.quoteServiceDownSince) / 60_000) }, 'QUOTE SERVICE DOWN: traders must exit with closeAtMark');
  }
}

every('cooldown-cleanup', 60_000, async () => pruneCooldowns(Date.now()));
every('liquidations', 5_000, liquidations);
every('orders', 3_000, triggerOrders);
every('settle', 30_000, settleCounter);
every('quote-probe', 60_000, probeQuoteService);

const app = new Hono();
app.get('/health', () => new Response(JSON.stringify({ ok: true, keeper: account.address, ...health }), { headers: { 'content-type': 'application/json' } }));
const server = Bun.serve({ port: env.PORT ?? env.KEEPER_PORT, fetch: app.fetch });
log.info({ keeper: account.address, port: server.port, markets: markets.length }, 'keeper started');
