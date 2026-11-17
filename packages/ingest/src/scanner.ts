import { z } from 'zod';

// The runner scanner: how each listed stock is trading today, from the same public Robinhood fundamentals and quotes the
// market-data refresh reads (see fundamentals.ts). Everything here describes the underlying stock, not our on-chain mark.

const num = z.string().nullable().optional();
const fundamentals = z.looseObject({
  open: num,
  high: num,
  low: num,
  volume: num,
  average_volume: num,
  average_volume_30_days: num,
  high_52_weeks: num,
  low_52_weeks: num,
  float: num,
  market_cap: num,
  shares_outstanding: num,
  market_date: num,
  sector: num,
  industry: num,
});
const quote = z.looseObject({
  last_trade_price: num,
  venue_last_trade_time: num,
  last_non_reg_trade_price: num,
  venue_last_non_reg_trade_time: num,
  previous_close: num,
  adjusted_previous_close: num,
  previous_close_date: num,
  trading_halted: z.boolean().nullable().optional(),
  updated_at: num,
});

export type ScannerTag =
  | 'runner'
  | 'fader'
  | 'gap_up'
  | 'gap_down'
  | 'high_volume'
  | 'extended_mover'
  | 'near_52w_high'
  | 'near_52w_low'
  | 'low_float'
  | 'halted';

export interface ScannerRow {
  symbol: string;
  /** The session these figures describe (YYYY-MM-DD), as Robinhood reports it. */
  marketDate: string | null;
  last: number | null;
  previousClose: number | null;
  previousCloseDate: string | null;
  /** Last regular-session trade against the previous close, in percent. */
  changePct: number | null;
  /** The latest pre-market, after-hours or overnight trade, when it is newer than the last regular trade. */
  extended: { price: number; changePct: number; at: string | null } | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** The session's open against the previous close, in percent. */
  gapPct: number | null;
  /** Where the last trade sits in the day's range: 0 at the low, 1 at the high. */
  rangePosition: number | null;
  volume: number | null;
  /** 30-day average daily share volume (falls back to Robinhood's default average). */
  avgVolume: number | null;
  /** Session volume divided by the average. Not adjusted for the time of day, so it starts low each morning. */
  relativeVolume: number | null;
  float: number | null;
  /** Session volume as a percentage of the float. */
  floatTurnoverPct: number | null;
  marketCap: number | null;
  high52: number | null;
  low52: number | null;
  /** Distance from the 52-week high, in percent (0 or below). */
  fromHigh52Pct: number | null;
  halted: boolean;
  sector: string | null;
  industry: string | null;
  tags: ScannerTag[];
}

/** Thresholds for the tags. Exported so the page that explains them and the tests use the same numbers. */
export const SCANNER_RULES = {
  runnerPct: 10,
  faderPct: -10,
  gapPct: 5,
  highVolume: 2,
  extendedPct: 5,
  near52Pct: 3,
  lowFloatShares: 20_000_000,
} as const;

const positive = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const nonNegative = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const pct = (now: number | null, then: number | null): number | null => (now !== null && then !== null ? round(((now - then) / then) * 100, 2) : null);
const round = (n: number, dp: number): number => Math.round(n * 10 ** dp) / 10 ** dp;
const time = (s: string | null | undefined): number => {
  const t = s ? Date.parse(s.replace(/(\.\d{3})\d+/, '$1')) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * One scanner row from Robinhood's raw fundamentals and quote for a symbol. Either may be missing (an unknown ticker or a
 * failed half of the request): the row then carries nulls instead of guesses.
 */
export function scannerRow(symbol: string, rawFundamentals: unknown, rawQuote: unknown): ScannerRow {
  const f = fundamentals.safeParse(rawFundamentals ?? {}).data ?? {};
  const q = quote.safeParse(rawQuote ?? {}).data ?? {};

  const last = positive(q.last_trade_price);
  const previousClose = positive(q.adjusted_previous_close) ?? positive(q.previous_close);
  const open = positive(f.open);
  const high = positive(f.high);
  const low = positive(f.low);
  const volume = nonNegative(f.volume);
  const avgVolume = positive(f.average_volume_30_days) ?? positive(f.average_volume);
  const float = positive(f.float);
  const high52 = positive(f.high_52_weeks);
  const low52 = positive(f.low_52_weeks);

  const ext = positive(q.last_non_reg_trade_price);
  const extAt = time(q.venue_last_non_reg_trade_time);
  const regularAt = time(q.venue_last_trade_time);
  const extended = ext !== null && last !== null && extAt > regularAt ? { price: ext, changePct: pct(ext, last)!, at: q.venue_last_non_reg_trade_time ?? null } : null;

  const relativeVolume = volume !== null && avgVolume !== null ? round(volume / avgVolume, 2) : null;
  const changePct = pct(last, previousClose);
  const gapPct = pct(open, previousClose);
  const rangePosition = last !== null && high !== null && low !== null && high > low ? round(Math.min(1, Math.max(0, (last - low) / (high - low))), 3) : null;
  const fromHigh52Pct = last !== null && high52 !== null ? round(Math.min(0, ((last - high52) / high52) * 100), 2) : null;
  const halted = q.trading_halted === true;

  const tags: ScannerTag[] = [];
  if (halted) tags.push('halted');
  if (changePct !== null && changePct >= SCANNER_RULES.runnerPct) tags.push('runner');
  if (changePct !== null && changePct <= SCANNER_RULES.faderPct) tags.push('fader');
  if (gapPct !== null && gapPct >= SCANNER_RULES.gapPct) tags.push('gap_up');
  if (gapPct !== null && gapPct <= -SCANNER_RULES.gapPct) tags.push('gap_down');
  if (relativeVolume !== null && relativeVolume >= SCANNER_RULES.highVolume) tags.push('high_volume');
  if (extended && Math.abs(extended.changePct) >= SCANNER_RULES.extendedPct) tags.push('extended_mover');
  if (fromHigh52Pct !== null && fromHigh52Pct >= -SCANNER_RULES.near52Pct) tags.push('near_52w_high');
  if (last !== null && low52 !== null && last <= low52 * (1 + SCANNER_RULES.near52Pct / 100)) tags.push('near_52w_low');
  if (float !== null && float < SCANNER_RULES.lowFloatShares) tags.push('low_float');

  return {
    symbol,
    marketDate: f.market_date ?? null,
    last,
    previousClose,
    previousCloseDate: q.previous_close_date ?? null,
    changePct,
    extended,
    open,
    high,
    low,
    gapPct,
    rangePosition,
    volume,
    avgVolume,
    relativeVolume,
    float,
    floatTurnoverPct: volume !== null && float !== null ? round((volume / float) * 100, 2) : null,
    marketCap: positive(f.market_cap),
    high52,
    low52,
    fromHigh52Pct,
    halted,
    sector: f.sector ?? null,
    industry: f.industry ?? null,
    tags,
  };
}
