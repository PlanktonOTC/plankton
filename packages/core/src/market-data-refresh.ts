import type { MarketData } from './eligibility.ts';

// Builds the listing-rule figures (config/market-data.json) from Robinhood's public fundamentals and quotes, so the 14-day
// freeze never depends on someone remembering to edit a file. Pure functions only: fetching lives in @plankton/ingest.

/** The fields of Robinhood's public `fundamentals` answer that matter here (all numbers arrive as strings). */
export interface FundamentalsRow {
  market_cap?: string | null;
  average_volume?: string | null;
  market_date?: string | null;
}

/** The fields of Robinhood's public `quotes` answer that matter here. */
export interface QuoteRow {
  previous_close?: string | null;
  adjusted_previous_close?: string | null;
  previous_close_date?: string | null;
}

export type RefreshResult = { ok: true; row: MarketData; changed: boolean } | { ok: false; reason: string };

/** A new market cap more than this many times above or below the one on file is refused: it is far more likely a bad read. */
export const MAX_CAP_JUMP = 3;
/** Never add more than this many sessions to a counter in one refresh (a week), however long the gap. */
const MAX_SESSIONS_PER_REFRESH = 7;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const positive = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Whole weekdays in (from, to]: the sessions between two dates, ignoring exchange holidays (it can only over-count by a holiday). */
export function weekdaysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let n = 0;
  for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

/**
 * Consecutive sessions a market cap has been above a threshold. Above: the count grows by the sessions that passed since the
 * figures on file. Not above: it resets. An older or equal date changes nothing (a repeated refresh never double counts).
 */
export function nextSessionCount(previousCount: number | undefined, previousAsOf: string | undefined, asOf: string, above: boolean): number {
  const before = previousCount ?? 0;
  if (!previousAsOf || !(Date.parse(asOf) > Date.parse(previousAsOf))) return above ? before : 0;
  if (!above) return 0;
  return before + Math.min(MAX_SESSIONS_PER_REFRESH, Math.max(1, weekdaysBetween(previousAsOf, asOf)));
}

/**
 * The market-data row for one stock, or why it cannot be built. Average daily dollar volume is the average share volume
 * times the previous close, the same recipe the file has always used. A refusal keeps the row already on file.
 */
export function buildMarketDataRow(args: {
  fundamentals: FundamentalsRow | undefined;
  quote: QuoteRow | undefined;
  previous: MarketData | undefined;
  todayYmd: string;
}): RefreshResult {
  const { fundamentals: f, quote: q, previous, todayYmd } = args;
  if (!f) return { ok: false, reason: 'no fundamentals returned' };
  if (!q) return { ok: false, reason: 'no quote returned' };

  const cap = positive(f.market_cap);
  if (cap === null) return { ok: false, reason: 'market cap missing or not positive' };
  const avgShares = positive(f.average_volume);
  if (avgShares === null) return { ok: false, reason: 'average volume missing or not positive' };
  const close = positive(q.previous_close) ?? positive(q.adjusted_previous_close);
  if (close === null) return { ok: false, reason: 'previous close missing or not positive' };

  const asOf = q.previous_close_date && YMD.test(q.previous_close_date) ? q.previous_close_date : f.market_date && YMD.test(f.market_date) ? f.market_date : null;
  if (asOf === null) return { ok: false, reason: 'no valid date on the figures' };
  if (asOf > todayYmd) return { ok: false, reason: `figures are dated in the future (${asOf})` };

  if (previous && previous.marketCapUsd > 0 && (cap > previous.marketCapUsd * MAX_CAP_JUMP || cap < previous.marketCapUsd / MAX_CAP_JUMP)) {
    return { ok: false, reason: `market cap moved more than ${MAX_CAP_JUMP}x since the figures on file (${Math.round(previous.marketCapUsd)} to ${Math.round(cap)}): check by hand` };
  }
  // The same close, or an older one, than what is on file: keep what we have. A figure set for a session that is already
  // covered (possibly checked by hand, with its own session counters) is never churned or overwritten by a rebuild.
  if (previous && Date.parse(asOf) <= Date.parse(previous.asOf)) return { ok: true, row: previous, changed: false };

  const row: MarketData = {
    marketCapUsd: Math.round(cap),
    avgDailyDollarVolumeUsd: Math.round(avgShares * close),
    asOf,
    sessionsAbove2B: nextSessionCount(previous?.sessionsAbove2B, previous?.asOf, asOf, cap >= 2_000_000_000),
    sessionsAbove10B: nextSessionCount(previous?.sessionsAbove10B, previous?.asOf, asOf, cap >= 10_000_000_000),
  };
  // Zero counters are left out of the file, as they always were.
  if (!row.sessionsAbove2B) delete row.sessionsAbove2B;
  if (!row.sessionsAbove10B) delete row.sessionsAbove10B;
  const changed = !previous || previous.asOf !== row.asOf || previous.marketCapUsd !== row.marketCapUsd || previous.avgDailyDollarVolumeUsd !== row.avgDailyDollarVolumeUsd
    || (previous.sessionsAbove2B ?? 0) !== (row.sessionsAbove2B ?? 0) || (previous.sessionsAbove10B ?? 0) !== (row.sessionsAbove10B ?? 0);
  return { ok: true, row, changed };
}

/** The newer of two rows for each symbol (by date); on a tie the first one wins. Neither input is changed. */
export function mergeMarketData(a: Record<string, MarketData>, b: Record<string, MarketData>): Record<string, MarketData> {
  const out: Record<string, MarketData> = { ...a };
  for (const [symbol, row] of Object.entries(b)) {
    const mine = out[symbol];
    if (!mine || Date.parse(row.asOf) > Date.parse(mine.asOf)) out[symbol] = row;
  }
  return out;
}

export interface RefreshReport {
  at: number;
  updated: string[];
  unchanged: string[];
  failed: Record<string, string>;
}
