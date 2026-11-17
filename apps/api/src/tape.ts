import type { Logger } from 'pino';
import type { Env, MarketConfig } from '@plankton/config';
import {
  fetchEarnings,
  fetchRhCorpActions,
  fetchStockFigures,
  fetchSubmissions,
  parseSubmissions,
  scannerRow,
  summarizeEarnings,
  type EarningsSummary,
  type Filing,
  type ScannerRow,
} from '@plankton/ingest';

// The Tape's market context: the runner scanner, the catalyst calendar and SEC filings for every listed market. Each comes
// from a public source that answers slowly or asks to be read sparingly, so each is cached here and refreshed in the
// background: a reader gets the last good answer at once, and a failed refresh keeps it instead of erroring.

export interface Cached<T> {
  value: T;
  /** When this value was loaded (ms). */
  at: number;
}

/**
 * Stale-while-revalidate around `load`. Fresh (younger than `ttlMs`): served as is. Stale: served, and one refresh starts
 * in the background. Older than `maxStaleMs`, or nothing loaded yet: the caller waits for a load. Concurrent callers share
 * one load. A failed background refresh is logged and the stale value kept.
 */
export function swr<T>(ttlMs: number, maxStaleMs: number, load: () => Promise<T>, onError: (err: unknown) => void = () => {}, now = () => Date.now()) {
  let cached: Cached<T> | null = null;
  let inflight: Promise<Cached<T>> | null = null;
  const refresh = () =>
    (inflight ??= load()
      .then((value) => (cached = { value, at: now() }))
      .finally(() => {
        inflight = null;
      }));
  return async (): Promise<Cached<T>> => {
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < ttlMs) return cached;
    if (cached && age < maxStaleMs) {
      refresh().catch(onError);
      return cached;
    }
    return refresh();
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface CorporateActionRow {
  symbol: string;
  id: string;
  type: string;
  status: string;
  processDate: string | null;
  details: unknown;
}

export interface CatalystsBody {
  updatedAt: string;
  earnings: EarningsSummary[];
  corporateActions: CorporateActionRow[];
  /** Symbols whose earnings could not be read on the last refresh (they keep their previous answer if there was one). */
  unavailable: string[];
}

export interface MarketFilings {
  symbol: string;
  cik: number;
  company: string;
  filings: Filing[];
}

export interface FilingsBody {
  updatedAt: string;
  lookbackDays: number;
  markets: MarketFilings[];
  unavailable: string[];
}

export interface ScannerBody {
  updatedAt: string;
  rows: ScannerRow[];
}

const FILINGS_LOOKBACK_DAYS = 45;
const FILINGS_PER_MARKET = 25;

export function createTape(env: Env, markets: MarketConfig[], log: Logger) {
  const symbols = markets.map((m) => m.symbol);
  const listed = new Set(symbols);
  const warn = (what: string) => (err: unknown) => log.warn({ err: (err as Error).message }, `${what} refresh failed; serving the last answer`);

  // Quotes move all day; Robinhood answers in under a second normally but up to 30 s on a bad day.
  const scanner = swr<ScannerBody>(30_000, 30 * MINUTE, async () => {
    const { fundamentals, quotes } = await fetchStockFigures(env.RH_FUNDAMENTALS_BASE, symbols);
    return { updatedAt: new Date().toISOString(), rows: symbols.map((s) => scannerRow(s, fundamentals[s], quotes[s])) };
  }, warn('scanner'));

  // Earnings dates change a few times a quarter: refresh every three hours, one symbol at a time.
  let lastEarnings = new Map<string, EarningsSummary>();
  const catalysts = swr<CatalystsBody>(3 * HOUR, 7 * DAY, async () => {
    const today = new Date().toISOString().slice(0, 10);
    const next = new Map<string, EarningsSummary>();
    const unavailable: string[] = [];
    for (const symbol of symbols) {
      try {
        next.set(symbol, summarizeEarnings(symbol, await fetchEarnings(env.RH_FUNDAMENTALS_BASE, symbol), today));
      } catch (err) {
        unavailable.push(symbol);
        const previous = lastEarnings.get(symbol);
        if (previous) next.set(symbol, previous);
        log.debug({ symbol, err: (err as Error).message }, 'earnings unavailable');
      }
      await sleep(150);
    }
    if (unavailable.length === symbols.length) throw new Error('no earnings could be read');
    lastEarnings = next;
    let corporateActions: CorporateActionRow[] = [];
    try {
      const nowMs = Date.now();
      corporateActions = (await fetchRhCorpActions(env.RH_API_BASE))
        .filter((a) => listed.has(a.tokenSymbol))
        .map((a) => ({
          symbol: a.tokenSymbol,
          id: a.id,
          type: a.type.replace(/^CORPORATE_ACTION_TYPE_/, '').toLowerCase(),
          status: a.status.replace(/^CORPORATE_ACTION_STATUS_/, '').toLowerCase(),
          processDate: a.processDate ? `${a.processDate.year}-${String(a.processDate.month).padStart(2, '0')}-${String(a.processDate.day).padStart(2, '0')}` : null,
          details: (a as { details?: unknown }).details ?? null,
        }))
        // Recent and upcoming only: a completed action from months ago is history, not a catalyst.
        .filter((a) => a.processDate === null || Date.parse(a.processDate) >= nowMs - 30 * DAY);
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'corporate actions unavailable');
    }
    const earnings = symbols.map((s) => next.get(s)).filter((e): e is EarningsSummary => Boolean(e));
    return { updatedAt: new Date().toISOString(), earnings, corporateActions, unavailable };
  }, warn('catalysts'));

  // EDGAR: one request per company, spaced well under the 10-per-second limit, every 10 minutes at most.
  let lastFilings = new Map<string, MarketFilings>();
  const filings = swr<FilingsBody>(10 * MINUTE, DAY, async () => {
    const sinceMs = Date.now() - FILINGS_LOOKBACK_DAYS * DAY;
    const next = new Map<string, MarketFilings>();
    const unavailable: string[] = [];
    const withCik = markets.filter((m) => m.secCik);
    for (const m of withCik) {
      try {
        const doc = parseSubmissions(await fetchSubmissions(env.SEC_API_BASE, m.secCik!, env.SEC_USER_AGENT), { sinceMs, limit: FILINGS_PER_MARKET });
        next.set(m.symbol, { symbol: m.symbol, cik: doc.cik, company: doc.name, filings: doc.filings });
      } catch (err) {
        unavailable.push(m.symbol);
        const previous = lastFilings.get(m.symbol);
        if (previous) next.set(m.symbol, previous);
        log.debug({ symbol: m.symbol, err: (err as Error).message }, 'filings unavailable');
      }
      await sleep(200);
    }
    if (withCik.length > 0 && unavailable.length === withCik.length) throw new Error('no filings could be read');
    lastFilings = next;
    return {
      updatedAt: new Date().toISOString(),
      lookbackDays: FILINGS_LOOKBACK_DAYS,
      markets: withCik.map((m) => next.get(m.symbol)).filter((x): x is MarketFilings => Boolean(x)),
      unavailable,
    };
  }, warn('filings'));

  return {
    scanner: async () => (await scanner()).value,
    catalysts: async () => (await catalysts()).value,
    filings: async () => (await filings()).value,
  };
}

export type Tape = ReturnType<typeof createTape>;

/** All markets' filings in one list, newest first; `flaggedOnly` keeps the medium and high importance ones. */
export function latestFilings(body: FilingsBody, opts: { flaggedOnly?: boolean; limit?: number } = {}) {
  return body.markets
    .flatMap((m) => m.filings.map((f) => ({ symbol: m.symbol, company: m.company, ...f })))
    .filter((f) => !opts.flaggedOnly || f.importance !== 'low')
    .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))
    .slice(0, opts.limit ?? 100);
}
