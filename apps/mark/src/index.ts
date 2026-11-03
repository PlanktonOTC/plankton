import { timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { Hono } from 'hono';
import pino from 'pino';
import type { Address } from 'viem';
import { loadCalendar, loadDeployment, loadEnv, loadMarkets, MIN_CALENDAR_HORIZON_DAYS, urlList } from '@plankton/config';
import { createChainClient, marketIdFor, oracleAbi } from '@plankton/chain';
import { createDb } from '@plankton/db';
import { formatE18, statusName } from '@plankton/core';
import { Publisher } from './publisher.ts';
import { MarkRunner, type MarkSink } from './runner.ts';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });

const { markets, rung } = loadMarkets();
const { calendar, horizonDays } = loadCalendar();
if (horizonDays < MIN_CALENDAR_HORIZON_DAYS) {
  const msg = `calendar covers only ${horizonDays} days ahead (minimum ${MIN_CALENDAR_HORIZON_DAYS})`;
  if (env.NODE_ENV === 'production') throw new Error(msg);
  log.warn(msg);
}

/** Placeholder sink until the on-chain publisher exists: log status changes and a once-a-minute price line. */
const lastLogged = new Map<string, { status: number; at: number }>();
const logSink: MarkSink = {
  onDecision(symbol, d, now) {
    const prev = lastLogged.get(symbol);
    if (prev && prev.status === d.status && now - prev.at < 60_000) return;
    lastLogged.set(symbol, { status: d.status, at: now });
    log.info(
      { symbol, status: statusName(d.status), price: formatE18(d.priceE18, 4), confidenceBps: d.confidenceBps, sources: d.sources, reason: d.reason },
      'mark',
    );
  },
};

const client = createChainClient(env.RPC_URLS);

// The publisher needs deployed contracts, signer services and a funded wallet. Without them the service still
// computes and serves marks, so prices can be checked before launch.
const sinks: MarkSink[] = [logSink];
let publisher: Publisher | null = null;
try {
  const dep = loadDeployment();
  const signerUrls = urlList(env.MARK_SIGNER_URLS);
  if (env.PUBLISHER_PRIVATE_KEY && env.SIGNER_AUTH_TOKEN && signerUrls.length > 0) {
    publisher = new Publisher({
        log,
        client,
        rpcUrls: env.RPC_URLS,
        dep,
        privateKey: env.PUBLISHER_PRIVATE_KEY as `0x${string}`,
        markets: new Map(markets.map((m) => [m.symbol, marketIdFor(m.symbol, m.stockToken as Address)])),
        quorumMarkets: new Set(markets.filter((m) => !m.chainlinkFeed).map((m) => m.symbol)),
        signerUrls,
        signerToken: env.SIGNER_AUTH_TOKEN,
        db: env.DATABASE_URL ? createDb(env.DATABASE_URL, { max: 2 }).db : undefined,
        holder: `${hostname()}-${process.pid}`,
    });
    sinks.push(publisher);
  } else {
    log.warn('publisher disabled: set PUBLISHER_PRIVATE_KEY, MARK_SIGNER_URLS and SIGNER_AUTH_TOKEN');
  }
} catch (err) {
  log.warn({ err: (err as Error).message }, 'publisher disabled');
}
const sink: MarkSink = {
  async onDecision(symbol, d, now) {
    for (const s of sinks) await s.onDecision(symbol, d, now);
  },
};

const runner = new MarkRunner({ env, markets, calendar, client, sink, log });

// Seed each market's held price from the last mark on the oracle (skipped before the contracts exist).
try {
  const dep = loadDeployment();
  const seeded = await Promise.all(
    markets.map(async (m) => {
      const mark = await client.readContract({
        address: dep.oracle,
        abi: oracleAbi,
        functionName: 'markOf',
        args: [marketIdFor(m.symbol, m.stockToken as Address)],
      });
      runner.seed(m.symbol, mark.priceE18);
      return mark.priceE18 > 0n;
    }),
  );
  log.info({ seeded: seeded.filter(Boolean).length }, 'seeded held marks from the oracle');
} catch (err) {
  log.warn({ err: (err as Error).message.split('\n')[0] }, 'could not seed from the oracle');
}

/** Run `fn` every `ms`, never overlapping itself, never throwing. */
function every(name: string, ms: number, fn: () => Promise<void>): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.warn({ err: (err as Error).message }, `${name} failed`);
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(run, ms);
}

every('robinhood', 15_000, () => runner.pollRobinhood());
every('chainlink', 5_000, () => runner.pollChainlink());
every('halts', 30_000, () => runner.pollHalts());
every('corporate-actions', 3_600_000, () => runner.pollCorporateActions());
every('market-data', 300_000, () => runner.pollMarketData());
every('tick', 2_000, () => runner.tick());

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const app = new Hono();
app.get('/health', () => json({ ok: true, rung, ...runner.health() }));
app.get('/marks', () => json(runner.marks()));
app.get('/eligibility', () => json(runner.eligibility()));

// On demand (Float's rule): the API calls this right before quoting, so the oracle holds a current price only when
// someone is about to trade. Internal only: same bearer token the signers use.
app.post('/publish/:symbol', async (c) => {
  const auth = c.req.header('authorization') ?? '';
  const expected = `Bearer ${env.SIGNER_AUTH_TOKEN ?? ''}`;
  if (!env.SIGNER_AUTH_TOKEN || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!publisher) return json({ error: 'publisher disabled' }, 503);
  const symbol = c.req.param('symbol').toUpperCase();
  const decision = runner.decisionOf(symbol);
  if (!decision) return json({ error: 'no mark for this market yet' }, 503);
  try {
    return json({ published: await publisher.ensureFresh(symbol, decision) });
  } catch (err) {
    log.warn({ symbol, err: (err as Error).message }, 'on-demand publish failed');
    return json({ error: 'publish failed' }, 503);
  }
});

app.get('/sources/:symbol', (c) => {
  const s = runner.sources(c.req.param('symbol').toUpperCase());
  return s ? json(s) : json({ error: 'unknown market' }, 404);
});

const server = Bun.serve({ port: env.MARK_PORT, fetch: app.fetch });
log.info({ port: server.port, markets: markets.map((m) => m.symbol), rung }, 'mark service started');
