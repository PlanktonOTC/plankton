import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import pino from 'pino';
import { encodeFunctionData, erc20Abi, parseAbi, recoverTypedDataAddress, verifyMessage, type Address, type Hex } from 'viem';
import { z, ZodError } from 'zod';
import { loadCalendar, loadDeployment, loadEnv, loadMarkets, need, requireDatabaseUrl, urlList } from '@plankton/config';
import {
  ROBINHOOD_CHAIN_ID,
  chainTimeSec,
  createChainClient,
  exchangeAbi,
  exchangeDomain,
  marketIdFor,
  orderTypes,
  orderWire,
  payoutDeskAbi,
  permitTypedData,
  quoteWire,
  readCounter,
  readMarket,
  readTrader,
  signature as signatureSchema,
  toJson,
  vaultAbi,
  wire,
  type ChainClient,
  type Deployment,
  type TraderSnapshot,
  type TradeQuoteMsg,
} from '@plankton/chain';
import { and, createDb, desc, eq, orders, positions, sql, trades, type Db } from '@plankton/db';
import { closeSizeDeltaE18, stressNavUsdg } from '@plankton/core';
import { marketLimits, quoteFromChain, type MarketLimits } from './quote.ts';
import { collateralShortfall, liquidationPriceE18, positionAfterOpen, positionValue, solveOpenSize, targetNotional } from './views.ts';
import { clientIp, corsOrigins, createRateLimiter, isInternal } from './limits.ts';

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

const app = new Hono<{ Bindings: { ip?: string } }>();

// ---------------------------------------------------------------- protection for a public endpoint

const rateCheck = createRateLimiter();
const production = env.NODE_ENV === 'production';
app.use('*', cors({ origin: corsOrigins(env.CORS_ORIGINS, production) as never, allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], maxAge: 600 }));
app.use('*', async (c, next) => {
  c.header('x-content-type-options', 'nosniff');
  c.header('cache-control', 'no-store');
  if (c.req.path === '/health' || isInternal(c.req.raw.headers, env.INTERNAL_API_TOKEN)) return next();
  // Quotes spend a signer's notional budget and orders write to the database, so they get a third of the general allowance.
  const heavy = c.req.method !== 'GET' && c.req.method !== 'OPTIONS';
  const limit = heavy ? Math.max(1, Math.floor(env.API_RATE_LIMIT_PER_MIN / 3)) : env.API_RATE_LIMIT_PER_MIN;
  const ip = clientIp(c.req.raw.headers, c.env?.ip, env.TRUST_PROXY === 'true');
  const r = rateCheck(`${heavy ? 'w' : 'r'}:${ip}`, limit);
  if (!r.ok) {
    c.header('retry-after', String(r.retryAfterSec));
    return json({ error: 'rate limit reached, slow down' }, 429);
  }
  return next();
});

app.get('/health', (c) => c.json({ ok: true, rung }));

// ---------------------------------------------------------------- markets and status

/**
 * The market's rules and on-chain mark right now, for the board and the ticket. Cached for a couple of seconds so a page
 * polling every few seconds, times every open tab, does not become a flood of RPC calls. Null when the chain is not reachable
 * or the contracts are not deployed: the board then still lists the market, without limits.
 */
type Trading = MarketLimits & { markE18: bigint; markStatus: number; markUpdatedAt: bigint; markConfidenceBps: number; markSequence: bigint };
const TRADING_TTL_MS = 2_000;
const tradingCache = new Map<string, { at: number; value: Trading | null }>();
async function tradingFor(symbol: string): Promise<Trading | null> {
  const hit = tradingCache.get(symbol);
  if (hit && Date.now() - hit.at < TRADING_TTL_MS) return hit.value;
  let value: Trading | null = null;
  try {
    const m = market(symbol);
    const { client, dep } = chain();
    const snap = await readMarket(client, dep, m.marketId);
    value = {
      ...marketLimits(snap, m.cfg.class, rung),
      markE18: snap.mark.priceE18,
      markStatus: snap.mark.status,
      markUpdatedAt: BigInt(snap.mark.updatedAt),
      markConfidenceBps: snap.mark.confidenceBps,
      markSequence: snap.mark.sequence,
    };
  } catch (err) {
    log.debug({ symbol, err: (err as Error).message }, 'market limits unavailable');
  }
  tradingCache.set(symbol, { at: Date.now(), value });
  return value;
}

// Board: configured markets joined with the live mark (mark service) and the rules in force (chain). Each half degrades
// on its own: a market with no mark yet has mark null, and a dead mark service shows as markFeedUp false.
app.get('/v1/markets', async () => {
  const [marks, trading] = await Promise.all([
    fromMark<Array<{ symbol: string }>>('/marks').catch(() => null),
    Promise.all(markets.map((m) => tradingFor(m.symbol))),
  ]);
  const bySym = new Map((marks ?? []).map((m) => [m.symbol, m]));
  return json(
    markets.map((m, i) => ({
      symbol: m.symbol,
      class: m.class,
      stockToken: m.stockToken,
      chainlinkFeed: m.chainlinkFeed,
      marketId: marketIdFor(m.symbol, m.stockToken as Address),
      markFeedUp: marks !== null,
      mark: bySym.get(m.symbol) ?? null,
      trading: trading[i] ?? null,
    })),
  );
});

// Everything a wallet needs to talk to the contracts. Addresses come from the deployment file, never hard-coded in the site.
app.get('/v1/config', async () => {
  const { client, dep } = chain();
  return json({
    chainId: ROBINHOOD_CHAIN_ID,
    rung,
    chainTimeSec: await chainTimeSec(client),
    quoteTtlSec: QUOTE_TTL_SEC,
    contracts: { exchange: dep.exchange, vault: dep.vault, usdg: dep.usdg, payoutDesk: dep.payoutDesk, oracle: dep.oracle },
    markets: markets.map((m) => ({ symbol: m.symbol, class: m.class, marketId: marketIdFor(m.symbol, m.stockToken as Address), stockToken: m.stockToken })),
  });
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

// ---------------------------------------------------------------- ticket preview (no signature, no signer budget)

const EMPTY_POSITION = { size: 0n, entry: 0n, margin: 0n, openedAt: 0n, openedBlock: 0n, borrowSnap: 0n };
const previewQuery = z
  .object({
    market: z.string(),
    trader: address.optional(),
    // Three ways to say what to trade. side + marginUsdg + leverage sizes the ticket for you; sizeBps closes part of the
    // trader's position; sizeDeltaE18 is an explicit size.
    side: z.enum(['long', 'short']).optional(),
    marginUsdg: uintStr.optional(),
    leverage: z.string().regex(/^\d{1,2}(\.\d{1,3})?$/).optional(),
    sizeBps: z.coerce.number().int().min(1).max(10_000).optional(),
    sizeDeltaE18: intStr.optional(),
  })
  .refine((q) => (q.side && q.marginUsdg !== undefined && q.leverage) || q.sizeBps !== undefined || q.sizeDeltaE18 !== undefined, {
    message: 'give side + marginUsdg + leverage, or sizeBps, or sizeDeltaE18',
  });

/**
 * What the ticket would cost right now, answered with the same rules the signed quote uses. It signs nothing, so it
 * can be called as the trader types. A refusal comes back as { ok: false, code, message } with HTTP 200: it is an answer.
 */
app.get('/v1/quote/preview', async (c) => {
  const q = previewQuery.parse(c.req.query());
  const m = market(q.market);
  const { client, dep } = chain();
  const [snap, tr]: [Awaited<ReturnType<typeof readMarket>>, TraderSnapshot] = await Promise.all([
    readMarket(client, dep, m.marketId),
    q.trader ? readTrader(client, dep, m.marketId, q.trader) : Promise.resolve({ position: EMPTY_POSITION, collateralUsdg: 0n, walletNotionalUsdg: 0n }),
  ]);
  const markE18 = snap.mark.priceE18;
  if (markE18 === 0n) return json({ ok: false, code: 'no_mark', message: 'this market has no price yet', markE18 });

  const nowMs = Number(await chainTimeSec(client)) * 1000;
  const marginUsdg = q.marginUsdg ?? 0n;
  const run = (sizeDeltaE18: bigint) =>
    quoteFromChain({ snap, trader: tr, cls: m.cfg.class, rung, sizeDeltaE18, marginUsdg, nowMs, calendar, windowTz: env.STOCK_TOKEN_WINDOW_TZ });

  let sizeDeltaE18: bigint;
  let outcome: ReturnType<typeof run>;
  if (q.side && q.leverage && q.marginUsdg !== undefined) {
    const solved = solveOpenSize((s) => { const r = run(s); return { result: r.result, execPriceE18: r.execPriceE18 }; }, q.side, targetNotional(q.marginUsdg, q.leverage), markE18);
    sizeDeltaE18 = solved.sizeDeltaE18;
    outcome = run(sizeDeltaE18);
  } else if (q.sizeBps !== undefined) {
    if (tr.position.size === 0n) return json({ ok: false, code: 'no_position', message: 'no open position to close', markE18 });
    sizeDeltaE18 = closeSizeDeltaE18(tr.position.size, q.sizeBps);
    outcome = run(sizeDeltaE18);
  } else {
    sizeDeltaE18 = q.sizeDeltaE18!;
    outcome = run(sizeDeltaE18);
  }

  const { result } = outcome;
  if (!result.ok) return json({ ok: false, code: result.code, message: result.message, sizeDeltaE18, markE18 });

  const current = { sizeE18: tr.position.size, entryE18: tr.position.entry, marginUsdg: BigInt(tr.position.margin) };
  const after = result.reducing ? null : positionAfterOpen(current, sizeDeltaE18, result.execPriceE18, marginUsdg);
  return json({
    ok: true,
    sizeDeltaE18,
    execPriceE18: result.execPriceE18,
    feeUsdg: result.feeUsdg,
    notionalUsdg: result.notionalUsdg,
    maxLeverageE18: outcome.maxLeverageE18,
    reducing: result.reducing,
    spreadBps: result.spreadBps,
    markE18,
    liquidationE18: after ? liquidationPriceE18(after, snap.cfg.maintenanceMarginBps) : null,
    collateralUsdg: tr.collateralUsdg,
    shortfallUsdg: collateralShortfall(marginUsdg, result.feeUsdg, result.reducing, tr.collateralUsdg),
  });
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

// Calldata to collect a deferred profit once it is claimable (anyone may send it; the money goes to the trader).
app.get('/v1/tx/claim', (c) => {
  const id = c.req.query('id') ?? '';
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'id must be a whole number');
  const { dep } = chain();
  return json({ to: dep.payoutDesk, data: encodeFunctionData({ abi: payoutDeskAbi, functionName: 'claim', args: [BigInt(id)] }) });
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
  const symbolOf = (marketId: string) => byId.get(marketId.toLowerCase())?.symbol ?? null;
  return json({
    trader,
    positions: pos.map((r) => ({ ...r, symbol: symbolOf(r.marketId) })),
    openOrders: open.map((r) => ({ ...r, symbol: symbolOf(r.marketId) })),
    recentTrades: recent.map((r) => ({ ...r, symbol: symbolOf(r.marketId) })),
  });
});

// What the chain says about one wallet right now: the deposited collateral, each open position valued at the current
// mark with its liquidation price, and the token balances the wallet screens need. Read straight from the contracts
// (not the indexed copy), so it is correct the moment a transaction confirms.
app.get('/v1/accounts/:addr/state', async (c) => {
  const addr = c.req.param('addr');
  if (!ADDRESS.test(addr)) throw new HttpError(400, 'invalid address');
  const who = addr as Address;
  const { client, dep } = chain();
  const ids = markets.map((m) => marketIdFor(m.symbol, m.stockToken as Address));
  const [head, held, limits] = await Promise.all([
    client.multicall({
      allowFailure: false,
      contracts: [
        { address: dep.exchange, abi: exchangeAbi, functionName: 'collateral', args: [who] },
        { address: dep.exchange, abi: exchangeAbi, functionName: 'walletNotional', args: [who] },
        { address: dep.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [who] },
        { address: dep.usdg, abi: usdgNonces, functionName: 'nonces', args: [who] },
        { address: dep.usdg, abi: erc20Abi, functionName: 'allowance', args: [who, dep.exchange] },
        { address: dep.usdg, abi: erc20Abi, functionName: 'allowance', args: [who, dep.vault] },
        { address: dep.vault, abi: vaultAbi, functionName: 'balanceOf', args: [who] },
        { address: dep.vault, abi: vaultAbi, functionName: 'navPerShareE18' },
      ],
    }),
    client.multicall({
      allowFailure: false,
      contracts: ids.map((id) => ({ address: dep.exchange, abi: exchangeAbi, functionName: 'positionOf' as const, args: [who, id] as const })),
    }),
    Promise.all(markets.map((m) => tradingFor(m.symbol))),
  ]);
  const [collateral, walletNotional, usdgBalance, usdgNonce, allowExchange, allowVault, shares, navPerShare] = head;
  const open = held.flatMap((p, i) => {
    if (p.size === 0n) return [];
    const m = markets[i]!;
    const lim = limits[i];
    const markE18 = lim?.markE18 ?? 0n;
    const mm = lim?.maintenanceMarginBps ?? 500;
    const view = { sizeE18: p.size, entryE18: p.entry, marginUsdg: BigInt(p.margin) };
    return [
      {
        symbol: m.symbol,
        marketId: ids[i]!,
        sizeE18: p.size,
        entryE18: p.entry,
        marginUsdg: BigInt(p.margin),
        openedAt: BigInt(p.openedAt),
        markE18,
        maintenanceMarginBps: mm,
        liquidationE18: liquidationPriceE18(view, mm),
        ...(markE18 > 0n ? positionValue(view, markE18, mm) : {}),
      },
    ];
  });
  return json({
    trader: addr.toLowerCase(),
    collateralUsdg: collateral,
    walletNotionalUsdg: walletNotional,
    usdgBalance,
    usdgNonce,
    usdgAllowanceExchange: allowExchange,
    usdgAllowanceVault: allowVault,
    vaultShares: shares,
    vaultSharesValueUsdg: (shares * navPerShare) / 10n ** 18n,
    positions: open,
  });
});

// Profits above the hourly payout limit are paid late through the PayoutDesk. This lists a trader's IOUs, read from the
// chain: the newest 500 claims are scanned, which covers many days at the volumes the hourly limit allows.
const CLAIM_SCAN = 500n;
app.get('/v1/accounts/:addr/claims', async (c) => {
  const addr = c.req.param('addr');
  if (!ADDRESS.test(addr)) throw new HttpError(400, 'invalid address');
  const { client, dep } = chain();
  const next = await client.readContract({ address: dep.payoutDesk, abi: payoutDeskAbi, functionName: 'nextClaimId' });
  const first = next > CLAIM_SCAN ? next - CLAIM_SCAN : 1n;
  const ids: bigint[] = [];
  for (let id = first; id < next; id++) ids.push(id);
  const [rows, now] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : client.multicall({ allowFailure: false, contracts: ids.map((id) => ({ address: dep.payoutDesk, abi: payoutDeskAbi, functionName: 'claims' as const, args: [id] as const })) }),
    chainTimeSec(client),
  ]);
  const mine = ids
    .map((id, i) => ({ id, row: rows[i]! }))
    .filter(({ row }) => row[0].toLowerCase() === addr.toLowerCase())
    .map(({ id, row }) => ({
      id,
      amountUsdg: row[1],
      claimableAt: row[2],
      frozenUntil: row[3],
      claimed: row[4],
      claimableNow: !row[4] && now >= BigInt(row[2]) && now >= BigInt(row[3]),
    }));
  return json({ trader: addr.toLowerCase(), claims: mine, scannedFromId: first });
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

const server = Bun.serve({
  port: env.API_PORT,
  maxRequestBodySize: 64 * 1024, // the largest legitimate body is a signed order, well under 2 KB
  fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
});
log.info({ port: server.port, markets: markets.map((m) => m.symbol), rung }, 'api started');
