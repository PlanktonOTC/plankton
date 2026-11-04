import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import pino from 'pino';
import { privateKeyToAccount } from 'viem/accounts';
import { loadDeployment, loadEnv, loadMarkets, need } from '@plankton/config';
import { fetchRhAssets, fetchRhPrices, rhReading } from '@plankton/ingest';
import {
  attestationTypes,
  attestationWire,
  chainTimeSec,
  createChainClient,
  exchangeAbi,
  exchangeDomain,
  markDomain,
  marketIdFor,
  oracleAbi,
  ROBINHOOD_CHAIN_ID,
  quoteTypes,
  quoteWire,
} from '@plankton/chain';
import { diffBps, notionalUsdg } from '@plankton/core';

// One process per key. SIGNER_ROLE=quote signs trade quotes; SIGNER_ROLE=mark signs price attestations.
// No signing endpoint is ever on the public API, and the API process holds no private key.

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const role = need(env.SIGNER_ROLE, 'SIGNER_ROLE');
const account = privateKeyToAccount(need(env.SIGNER_PRIVATE_KEY, 'SIGNER_PRIVATE_KEY') as `0x${string}`);
const token = Buffer.from(need(env.SIGNER_AUTH_TOKEN, 'SIGNER_AUTH_TOKEN'));
const dep = loadDeployment();
const client = createChainClient(env.RPC_URLS);

const tls =
  env.SIGNER_TLS_CERT && env.SIGNER_TLS_KEY && env.SIGNER_TLS_CA
    ? {
        cert: readFileSync(env.SIGNER_TLS_CERT),
        key: readFileSync(env.SIGNER_TLS_KEY),
        ca: readFileSync(env.SIGNER_TLS_CA),
        requestCert: true,
        rejectUnauthorized: true,
      }
    : undefined;
// A signer bound to loopback is reachable only from its own host (scripts/run-roles.ts runs it next to its callers),
// so it needs no mTLS. Anywhere else production refuses to start without it.
const loopbackOnly = ['127.0.0.1', '::1', 'localhost'].includes(env.SIGNER_HOST ?? '');
if (env.NODE_ENV === 'production' && !tls && !loopbackOnly) {
  throw new Error('production needs SIGNER_TLS_CERT, SIGNER_TLS_KEY and SIGNER_TLS_CA (mTLS), or SIGNER_HOST=127.0.0.1');
}

// Markets Chainlink does not cover, by marketId. Their marks have no on-chain fence, so this key checks each one
// against its own Robinhood read before signing: the quorum is then two independent checks, not two rubber stamps.
const singleSource = new Map(
  loadMarkets()
    .markets.filter((m) => !m.chainlinkFeed)
    .map((m) => [marketIdFor(m.symbol, m.stockToken as `0x${string}`).toLowerCase(), m]),
);
// Robinhood is read in the background (prices every 10 s, the asset list every 5 min), never while a request waits:
// its API can take seconds to answer, and a mark signed on a quote older than a minute is refused below anyway.
let rhQuotes: { at: number; quotes: Awaited<ReturnType<typeof fetchRhPrices>> } | null = null;
let rhAssets: { at: number; assets: Awaited<ReturnType<typeof fetchRhAssets>> } | null = null;
async function refreshRobinhood(): Promise<void> {
  try {
    if (!rhAssets || Date.now() - rhAssets.at > 300_000) rhAssets = { at: Date.now(), assets: await fetchRhAssets(env.RH_API_BASE) };
    rhQuotes = { at: Date.now(), quotes: await fetchRhPrices(env.RH_API_BASE) };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'robinhood refresh failed');
  }
}
if (role === 'mark' && singleSource.size > 0) {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    await refreshRobinhood();
    running = false;
  };
  void loop();
  setInterval(loop, 10_000);
}

// Deadlines are judged against chain time, because that is what the contracts compare them to.
const nowSec = async () => Number(await chainTimeSec(client));
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const reject = (reason: string, status = 422) => {
  log.warn({ reason, role }, 'refused to sign');
  return json({ error: reason }, status);
};

// ---- per-key notional limits (in memory; a restart resets them, which only ever makes the limit stricter than the clock)
const signed: Array<{ at: number; usdg: bigint }> = [];
function withinLimits(usdg: bigint, now: number): boolean {
  while (signed.length > 0 && signed[0]!.at < now - 86_400) signed.shift();
  let day = usdg;
  let minute = usdg;
  for (const s of signed) {
    day += s.usdg;
    if (s.at >= now - 60) minute += s.usdg;
  }
  return minute <= env.SIGNER_MAX_NOTIONAL_PER_MIN_USDG && day <= env.SIGNER_MAX_NOTIONAL_PER_DAY_USDG;
}

const lastMarkSequence = new Map<string, bigint>();

const app = new Hono();

app.use('*', async (c, next) => {
  const given = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer /, ''));
  if (given.length !== token.length || !timingSafeEqual(given, token)) return json({ error: 'unauthorized' }, 401);
  await next();
});

app.get('/health', () => json({ ok: true, role, address: account.address }));

app.post('/sign/quote', async (c) => {
  if (role !== 'quote') return json({ error: 'wrong role' }, 404);
  const parsed = quoteWire.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return reject('invalid quote');
  const q = parsed.data;
  const now = await nowSec();

  if (q.expiry < BigInt(now) || q.expiry > BigInt(now + 60)) return reject('expiry must be within the next 60 seconds');
  if (q.sizeDeltaE18 === 0n) return reject('zero size');

  // Independent check against the chain: price near the mark, fee in the contract's range.
  const [mark, cfg] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: dep.oracle, abi: oracleAbi, functionName: 'markOf', args: [q.marketId] },
      { address: dep.exchange, abi: exchangeAbi, functionName: 'configOf', args: [q.marketId] },
    ],
  });
  if (mark.priceE18 === 0n) return reject('no mark');
  const maxDev = BigInt(cfg.maxExecDeviationBps) + BigInt(cfg.frozenSpreadBps);
  if (diffBps(q.execPriceE18, mark.priceE18) > maxDev) return reject('price too far from the mark');
  const notional = notionalUsdg(q.sizeDeltaE18, q.execPriceE18);
  if (q.feeUsdg > (notional * (BigInt(cfg.feeBps) + BigInt(cfg.maxExecDeviationBps))) / 10_000n) return reject('fee too high');

  if (!withinLimits(notional, now)) return reject('notional limit reached for this key', 429);
  signed.push({ at: now, usdg: notional });

  const signature = await account.signTypedData({
    domain: exchangeDomain(dep.exchange),
    types: quoteTypes,
    primaryType: 'TradeQuote',
    message: q,
  });
  return json({ signature, signer: account.address });
});

app.post('/sign/mark', async (c) => {
  if (role !== 'mark') return json({ error: 'wrong role' }, 404);
  const parsed = attestationWire.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return reject('invalid attestation');
  const a = parsed.data;
  const now = BigInt(await nowSec());

  if (a.expiry < now || a.expiry > now + 180n) return reject('expiry must be within the next 3 minutes');
  if (a.observedAt > now + 5n || a.observedAt + 180n < now) return reject('observation time out of range');

  // Monotonic: never sign a sequence at or below one already signed (or already on-chain).
  let last = lastMarkSequence.get(a.marketId);
  if (last === undefined) last = (await client.readContract({ address: dep.oracle, abi: oracleAbi, functionName: 'markOf', args: [a.marketId] })).sequence;
  if (a.sequence <= last) return reject('sequence is not above the last one');

  // Own Chainlink read: in Open/Extended a mark far from Chainlink is not signed by this key at all.
  if (a.status === 1 || a.status === 2) {
    const [cl, clAt] = await client.readContract({ address: dep.oracle, abi: oracleAbi, functionName: 'chainlinkPrice', args: [a.marketId] });
    if (clAt !== 0n && diffBps(a.markE18, cl) > BigInt(env.SIGNER_MARK_MAX_DEV_BPS)) return reject('mark too far from Chainlink');
    const m = singleSource.get(a.marketId.toLowerCase());
    if (m) {
      if (!rhQuotes || !rhAssets || Date.now() - rhQuotes.at > 60_000) return reject('no fresh Robinhood read of my own to check this mark against');
      const own = rhReading(m.symbol, m.stockToken, ROBINHOOD_CHAIN_ID, rhQuotes.quotes, rhAssets.assets).observation;
      if (!own) return reject('no Robinhood quote of my own to check this mark against');
      if (diffBps(a.markE18, own.priceE18) > BigInt(env.SIGNER_SINGLE_SOURCE_MAX_DEV_BPS)) return reject('mark too far from my Robinhood read');
    }
  }
  lastMarkSequence.set(a.marketId, a.sequence);

  const signature = await account.signTypedData({
    domain: markDomain(dep.oracle),
    types: attestationTypes,
    primaryType: 'Attestation',
    message: a,
  });
  return json({ signature, signer: account.address });
});

const server = Bun.serve({ port: env.PORT ?? env.SIGNER_PORT, hostname: env.SIGNER_HOST, fetch: app.fetch, ...(tls ? { tls } : {}) });
log.info({ role, address: account.address, port: server.port, mtls: Boolean(tls) }, 'signer started');
