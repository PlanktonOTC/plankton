import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import pino from 'pino';
import { encodeFunctionData, parseAbi, recoverTypedDataAddress, verifyMessage, type Address, type Hex } from 'viem';
import { z, ZodError } from 'zod';
import { loadCalendar, loadDeployment, loadEnv, loadMarkets, need, requireDatabaseUrl, urlList } from '@plankton/config';
import {
  chainTimeSec,
  createChainClient,
  exchangeAbi,
  exchangeDomain,
  marketIdFor,
  orderTypes,
  orderWire,
  permitTypedData,
  quoteWire,
  readCounter,
  readMarket,
  readTrader,
  signature as signatureSchema,
  toJson,
  wire,
  type ChainClient,
  type Deployment,
  type TradeQuoteMsg,
} from '@plankton/chain';
import { and, createDb, desc, eq, orders, positions, sql, trades, type Db } from '@plankton/db';
import { closeSizeDeltaE18, stressNavUsdg } from '@plankton/core';
import { quoteFromChain } from './quote.ts';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const { markets, rung } = loadMarkets();
const { calendar } = loadCalendar();

const byId = new Map(markets.map((m) => [marketIdFor(m.symbol, m.stockToken as Address).toLowerCase(), m]));
const bySymbol = new Map(markets.map((m) => [m.symbol, { cfg: m, marketId: marketIdFor(m.symbol, m.stockToken as Address) }]));

class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422 | 429 | 503, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

let dbHandle: Db | null = null;
const db = (): Db => (dbHandle ??= createDb(requireDatabaseUrl(env)).db);

let chainCtx: { dep: Deployment; client: ChainClient } | null = null;
function chain() {
  if (!chainCtx) {
    try {
      chainCtx = { dep: loadDeployment(), client: createChainClient(env.RPC_URLS) };
    } catch (err) {
      throw new HttpError(503, `contracts are not deployed yet: ${(err as Error).message}`);
    }
  }
  return chainCtx;
}

const market = (symbol: string) => {
  const m = bySymbol.get(symbol.toUpperCase());
  if (!m) throw new HttpError(404, 'unknown market');
  return m;
};

const json = (v: unknown, status = 200) => new Response(toJson(v), { status, headers: { 'content-type': 'application/json' } });

/** Fetch from the mark service (it owns live prices). Short timeout: a dead mark service must not hang the API. */
async function fromMark<T>(path: string): Promise<T> {
  const res = await fetch(`${env.MARK_SERVICE_URL}${path}`, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`mark service ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- quote signing (the API never holds a key)

async function signQuote(msg: TradeQuoteMsg): Promise<{ signature: Hex; signer: Address }> {
  const urls = urlList(env.QUOTE_SIGNER_URLS);
  const token = need(env.SIGNER_AUTH_TOKEN, 'SIGNER_AUTH_TOKEN');
  if (urls.length === 0) throw new HttpError(503, 'quote_service_unavailable');
  const start = Math.floor(Math.random() * urls.length);
  for (let k = 0; k < urls.length; k++) {
    const url = urls[(start + k) % urls.length]!;
    try {
      const res = await fetch(`${url}/sign/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: toJson(wire(msg)),
        signal: AbortSignal.timeout(3_000),
      });
      if (res.status === 422 || res.status === 429) {
        // A refusal is the signer doing its job. Do not shop the request around other signers.
        throw new HttpError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'signer refused');
      }
      if (!res.ok) continue; // 5xx or auth problem: try the next signer
      const body = (await res.json()) as { signature: Hex; signer: Address };
      return body;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // network error or timeout: try the next signer
    }
  }
  throw new HttpError(503, 'quote_service_unavailable');
}

const closeAtMarkCall = (marketId: Hex, bps: number) => {
  const { dep } = chain();
  return { to: dep.exchange, data: encodeFunctionData({ abi: exchangeAbi, functionName: 'closeAtMark', args: [marketId, bps] }) };
};

const usdgNonces = parseAbi(['function nonces(address owner) view returns (uint256)']);

// ---------------------------------------------------------------- request shapes

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v as Address);
const intStr = z.string().regex(/^-?\d+$/).transform((v) => BigInt(v));
const uintStr = z.string().regex(/^\d+$/).transform((v) => BigInt(v));

const tradeBody = z.object({ market: z.string(), trader: address, sizeDeltaE18: intStr, marginUsdg: uintStr });
const closeBody = z.object({
  market: z.string(),
  trader: address,
  sizeBps: z.number().int().min(1).max(10_000).optional(),
  sizeDeltaE18: intStr.optional(),
});
const orderBody = orderWire.extend({ signature: signatureSchema });
const cancelBody = z.object({ trader: address, signature: signatureSchema });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_OPEN_ORDERS_PER_TRADER = 50;
const QUOTE_TTL_SEC = 20n;

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, rung }));

// ---------------------------------------------------------------- markets and status

// Board: configured markets joined with the live mark. A market with no mark yet shows status null.
app.get('/v1/markets', async () => {
  const marks = await fromMark<Array<{ symbol: string }>>('/marks');
  const bySym = new Map(marks.map((m) => [m.symbol, m]));
  return json(
    markets.map((m) => ({
      symbol: m.symbol,
      class: m.class,
      stockToken: m.stockToken,
      chainlinkFeed: m.chainlinkFeed,
      mark: bySym.get(m.symbol) ?? null,
    })),
  );
});

// "Why this mark": the latest value per source and how far apart they are.
app.get('/v1/markets/:symbol/sources', async (c) => {
  const { cfg } = market(c.req.param('symbol'));
  return json(await fromMark(`/sources/${cfg.symbol}`));
});

// Which markets pass the listing rule (market cap under $2B, price at least $1, volume at least $2M), and why not.
app.get('/v1/eligibility', async () => json(await fromMark('/eligibility')));

app.get('/v1/status', async () => {
  const [marks, health] = await Promise.all([fromMark<unknown[]>('/marks'), fromMark<unknown>('/health')]);
  return json({ markets: marks, feeds: health });
});

// ---------------------------------------------------------------- quotes

/**
 * Builds the quote from live chain state, has a signer sign it, and returns it with the USDG permit the wallet
 * needs when the trader's collateral does not cover margin + fee (one signature for permit + deposit + open).
 */
async function issueQuote(symbol: string, trader: Address, sizeDeltaE18: bigint, marginUsdg: bigint) {
  const m = market(symbol);
  const { client, dep } = chain();
  const [snap, tr] = await Promise.all([readMarket(client, dep, m.marketId), readTrader(client, dep, m.marketId, trader)]);
  if (snap.mark.priceE18 === 0n) throw new HttpError(503, 'no_mark', { closeAtMark: closeAtMarkCall(m.marketId, 10_000) });

  // Chain time, not the server clock: the quote's expiry and the mark's age are judged against block.timestamp.
  const nowSec = await chainTimeSec(client);
  const nowMs = Number(nowSec) * 1000;
  const { result, maxLeverageE18 } = quoteFromChain({
    snap,
    trader: tr,
    cls: m.cfg.class,
    rung,
    sizeDeltaE18,
    marginUsdg,
    nowMs,
    calendar,
    windowTz: env.STOCK_TOKEN_WINDOW_TZ,
  });
  if (!result.ok) throw new HttpError(422, result.code, { message: result.message });

  const quote: TradeQuoteMsg = {
    marketId: m.marketId,
    trader,
    sizeDeltaE18,
    execPriceE18: result.execPriceE18,
    feeUsdg: result.feeUsdg,
    maxLeverageE18,
    markSequence: snap.mark.sequence,
    nonce: BigInt(`0x${randomBytes(8).toString('hex')}`),
    expiry: nowSec + QUOTE_TTL_SEC,
  };
  const { signature, signer } = await signQuote(quote);

  const needed = (result.reducing ? 0n : marginUsdg) + result.feeUsdg;
  const shortfall = needed > tr.collateralUsdg ? needed - tr.collateralUsdg : 0n;
  let permit: ReturnType<typeof permitTypedData> | null = null;
  if (shortfall > 0n) {
    const nonce = await client.readContract({ address: dep.usdg, abi: usdgNonces, functionName: 'nonces', args: [trader] });
    permit = permitTypedData(trader, dep.exchange, shortfall, nonce, nowSec + 600n);
  }
  return { quote: wire(quote), signature, signer, reducing: result.reducing, spreadBps: result.spreadBps, permit };
}

app.post('/v1/quote/trade', async (c) => {
  const b = tradeBody.parse(await c.req.json().catch(() => null));
  return json(await issueQuote(b.market, b.trader, b.sizeDeltaE18, b.marginUsdg));
});

// Works in every market state. If no quote can be served, the response carries the closeAtMark call so the trader can still exit.
app.post('/v1/quote/close', async (c) => {
  const b = closeBody.parse(await c.req.json().catch(() => null));
  if (b.sizeBps === undefined && b.sizeDeltaE18 === undefined) throw new HttpError(400, 'give sizeBps or sizeDeltaE18');
  const m = market(b.market);
  const { client, dep } = chain();
  const tr = await readTrader(client, dep, m.marketId, b.trader);
  if (tr.position.size === 0n) throw new HttpError(404, 'no open position');
  const delta = b.sizeBps !== undefined ? closeSizeDeltaE18(tr.position.size, b.sizeBps) : b.sizeDeltaE18!;
  try {
    return json(await issueQuote(b.market, b.trader, delta, 0n));
  } catch (err) {
    if (err instanceof HttpError && err.status === 503) {
      throw new HttpError(503, err.message, { closeAtMark: closeAtMarkCall(m.marketId, b.sizeBps ?? 10_000) });
    }
    throw err;
  }
});

// Calldata for the permissionless exit. Needs no quote service, no database and no mark service.
app.get('/v1/tx/close-at-mark', (c) => {
  const m = market(c.req.query('market') ?? '');
  const bps = Number(c.req.query('bps') ?? '10000');
  if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) throw new HttpError(400, 'bps must be 1..10000');
  return json(closeAtMarkCall(m.marketId, bps));
});

// ---------------------------------------------------------------- orders (executed by keepers)

app.post('/v1/orders', async (c) => {
  const b = orderBody.parse(await c.req.json().catch(() => null));
  const { signature, ...order } = b;
  const { dep, client } = chain();
  const m = byId.get(order.marketId.toLowerCase());
  if (!m) throw new HttpError(404, 'unknown market');
  const now = await chainTimeSec(client); // the contract judges expiry by block time
  if (order.expiry <= now) throw new HttpError(422, 'order already expired');

  const signer = await recoverTypedDataAddress({
    domain: exchangeDomain(dep.exchange),
    types: orderTypes,
    primaryType: 'Order',
    message: order,
    signature,
  });
  if (signer.toLowerCase() !== order.trader.toLowerCase()) throw new HttpError(422, 'signature does not match the trader');

  const d = db();
  const trader = order.trader.toLowerCase();
  const [{ n }] = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.trader, trader), eq(orders.status, 'open')));
  if (n! >= MAX_OPEN_ORDERS_PER_TRADER) throw new HttpError(429, 'too many open orders');

  const inserted = await d
    .insert(orders)
    .values({
      nonce: order.nonce,
      trader,
      marketId: order.marketId.toLowerCase(),
      kind: order.kind,
      triggerE18: order.triggerE18.toString(),
      triggerAbove: order.triggerAbove,
      validAfter: new Date(Number(order.validAfter) * 1000),
      expiry: new Date(Number(order.expiry) * 1000),
      body: wire(order),
      sig: signature,
      status: 'open',
    })
    .onConflictDoNothing()
    .returning({ nonce: orders.nonce });
  if (inserted.length === 0) throw new HttpError(409, 'an order with this nonce already exists');
  return json({ ok: true, nonce: order.nonce, market: m.symbol }, 201);
});

// Off-chain cancel needs a signed message from the trader. The response also carries the on-chain cancel call,
// which is the only cancel that binds a keeper that has already picked the order up.
app.delete('/v1/orders/:nonce', async (c) => {
  const nonceStr = c.req.param('nonce');
  if (!/^\d+$/.test(nonceStr)) throw new HttpError(400, 'bad nonce');
  const nonce = BigInt(nonceStr);
  const b = cancelBody.parse(await c.req.json().catch(() => null));
  const ok = await verifyMessage({ address: b.trader, message: `plankton:cancel-order:${nonce}`, signature: b.signature });
  if (!ok) throw new HttpError(422, 'signature does not match the trader');

  const { dep } = chain();
  const updated = await db()
    .update(orders)
    .set({ status: 'cancelled' })
    .where(and(eq(orders.trader, b.trader.toLowerCase()), eq(orders.nonce, nonce), eq(orders.status, 'open')))
    .returning({ nonce: orders.nonce });
  return json({
    cancelledOffChain: updated.length > 0,
    onChain: { to: dep.exchange, data: encodeFunctionData({ abi: exchangeAbi, functionName: 'cancelOrder', args: [nonce] }) },
  });
});

// ---------------------------------------------------------------- accounts, counter, ledger

// Everything the account page needs, from the indexed copy of chain state.
app.get('/v1/accounts/:addr', async (c) => {
  const addr = c.req.param('addr');
  if (!ADDRESS.test(addr)) throw new HttpError(400, 'invalid address');
  const trader = addr.toLowerCase();
  const d = db();
  const [pos, open, recent] = await Promise.all([
    d.select().from(positions).where(eq(positions.trader, trader)),
    d.select().from(orders).where(and(eq(orders.trader, trader), eq(orders.status, 'open'))),
    d.select().from(trades).where(eq(trades.trader, trader)).orderBy(desc(trades.at)).limit(50),
  ]);
  return json({ trader, positions: pos, openOrders: open, recentTrades: recent });
});

app.get('/v1/counter', async () => {
  const { client, dep } = chain();
  return json(await readCounter(client, dep));
});

// Proof of solvency and a 25% stress test, straight from chain reads: nothing here is stored or estimated by us.
app.get('/v1/ledger', async () => {
  const { client, dep } = chain();
  const counter = await readCounter(client, dep);
  const perMarket = await Promise.all(
    [...bySymbol.entries()].map(async ([symbol, m]) => {
      const [snap, cap] = await Promise.all([
        readMarket(client, dep, m.marketId),
        client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'capacity', args: [m.marketId] }),
      ]);
      const V = counter.navUsdg;
      return {
        symbol,
        longOiUsdg: snap.longOI,
        shortOiUsdg: snap.shortOI,
        netSkewCapUsdg: (V * BigInt(snap.cfg.netSkewBpsOfV)) / 10_000n,
        grossCapUsdg: (V * BigInt(snap.cfg.grossOiBpsOfV)) / 10_000n,
        longRoomUsdg: cap[0],
        shortRoomUsdg: cap[1],
        badDebtUsdg: snap.badDebt,
      };
    }),
  );
  const nets = perMarket.map((r) => r.longOiUsdg - r.shortOiUsdg);
  const stress = stressNavUsdg(counter.navUsdg, nets, 2_500);
  return json({ counter, stress25: stress, markets: perMarket });
});

// ---------------------------------------------------------------- errors

app.onError((err, c) => {
  if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
  if (err instanceof ZodError) return json({ error: 'invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  if (err.message.includes('DATABASE_URL')) return json({ error: 'database is not configured' }, 503);
  log.error({ err: err.message, path: c.req.path }, 'request failed');
  return json({ error: 'internal error' }, 500);
});

const server = Bun.serve({ port: env.API_PORT, fetch: app.fetch });
log.info({ port: server.port, markets: markets.map((m) => m.symbol), rung }, 'api started');
