import { describe, expect, test } from 'bun:test';
import { buildMarketDataRow, mergeMarketData, nextSessionCount, weekdaysBetween } from '../src/market-data-refresh.ts';
import { checkEligibility } from '../src/eligibility.ts';

const f = (over: Record<string, string | null> = {}) => ({ market_cap: '389701103.8', average_volume: '2300841.52', market_date: '2026-11-16', ...over });
const q = (over: Record<string, string | null> = {}) => ({ previous_close: '9.43', previous_close_date: '2026-11-13', ...over });
const TODAY = '2026-11-17';

describe('weekdaysBetween', () => {
  test('counts the sessions after the first date up to and including the second', () => {
    expect(weekdaysBetween('2026-11-13', '2026-11-16')).toBe(1); // Fri -> Mon
    expect(weekdaysBetween('2026-11-09', '2026-11-13')).toBe(4); // Mon -> Fri
    expect(weekdaysBetween('2026-11-13', '2026-11-20')).toBe(5);
    expect(weekdaysBetween('2026-11-16', '2026-11-16')).toBe(0);
    expect(weekdaysBetween('2026-11-16', '2026-11-13')).toBe(0);
    expect(weekdaysBetween('nope', '2026-11-13')).toBe(0);
  });
});

describe('nextSessionCount', () => {
  test('grows with the sessions that passed while above', () => {
    expect(nextSessionCount(3, '2026-11-12', '2026-11-16', true)).toBe(5); // Fri + Mon
  });
  test('resets when not above', () => {
    expect(nextSessionCount(19, '2026-11-12', '2026-11-16', false)).toBe(0);
  });
  test('a repeated or older date never double counts', () => {
    expect(nextSessionCount(7, '2026-11-13', '2026-11-13', true)).toBe(7);
    expect(nextSessionCount(7, '2026-11-13', '2026-11-12', true)).toBe(7);
    expect(nextSessionCount(7, '2026-11-13', '2026-11-12', false)).toBe(0);
  });
  test('a first sighting starts at zero, a long gap is capped at a week', () => {
    expect(nextSessionCount(undefined, undefined, '2026-11-16', true)).toBe(0);
    expect(nextSessionCount(2, '2026-06-01', '2026-11-16', true)).toBe(9);
  });
});

describe('buildMarketDataRow', () => {
  test('builds a row the way the file always was: cap, average shares x previous close, the close date', () => {
    const r = buildMarketDataRow({ fundamentals: f(), quote: q(), previous: undefined, todayYmd: TODAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row).toEqual({ marketCapUsd: 389701104, avgDailyDollarVolumeUsd: Math.round(2300841.52 * 9.43), asOf: '2026-11-13' });
    expect(r.changed).toBe(true);
  });

  test('the fresh row clears the 14-day rule that froze the market', () => {
    const r = buildMarketDataRow({ fundamentals: f(), quote: q(), previous: { marketCapUsd: 389_000_000, avgDailyDollarVolumeUsd: 22_000_000, asOf: '2026-10-27' }, todayYmd: TODAY });
    if (!r.ok) throw new Error(r.reason);
    const before = checkEligibility('WYFI', 'small', { marketCapUsd: 389_000_000, avgDailyDollarVolumeUsd: 22_000_000, asOf: '2026-10-27' }, 8.6, Date.parse('2026-11-17T12:00:00Z'));
    const after = checkEligibility('WYFI', 'small', r.row, 8.6, Date.parse('2026-11-17T12:00:00Z'));
    expect(before.reasons.join()).toContain('days old');
    expect(after.eligible).toBe(true);
  });

  test('the same figures twice report no change', () => {
    const first = buildMarketDataRow({ fundamentals: f(), quote: q(), previous: undefined, todayYmd: TODAY });
    if (!first.ok) throw new Error(first.reason);
    const again = buildMarketDataRow({ fundamentals: f(), quote: q(), previous: first.row, todayYmd: TODAY });
    expect(again).toMatchObject({ ok: true, changed: false });
  });

  test('refuses what it cannot trust, with a reason', () => {
    const bad = (fundamentals: any, quote: any, previous?: any) => buildMarketDataRow({ fundamentals, quote, previous, todayYmd: TODAY });
    expect(bad(undefined, q())).toEqual({ ok: false, reason: 'no fundamentals returned' });
    expect(bad(f(), undefined)).toEqual({ ok: false, reason: 'no quote returned' });
    expect(bad(f({ market_cap: null }), q())).toMatchObject({ ok: false });
    expect(bad(f({ market_cap: '0' }), q())).toMatchObject({ ok: false });
    expect(bad(f({ average_volume: 'abc' }), q())).toMatchObject({ ok: false });
    expect(bad(f(), q({ previous_close: null, adjusted_previous_close: null }))).toMatchObject({ ok: false });
    expect(bad(f(), q({ previous_close_date: null }), undefined)).toMatchObject({ ok: true }); // falls back to market_date
    expect(bad(f({ market_date: null }), q({ previous_close_date: 'x' }))).toMatchObject({ ok: false, reason: 'no valid date on the figures' });
    expect(bad(f(), q({ previous_close_date: '2026-12-31' }))).toMatchObject({ ok: false });
  });

  test('a market cap that jumps more than 3x is held for a human', () => {
    const previous = { marketCapUsd: 100_000_000, avgDailyDollarVolumeUsd: 5_000_000, asOf: '2026-11-06' };
    expect(buildMarketDataRow({ fundamentals: f({ market_cap: '500000000' }), quote: q(), previous, todayYmd: TODAY })).toMatchObject({ ok: false });
    expect(buildMarketDataRow({ fundamentals: f({ market_cap: '20000000' }), quote: q(), previous, todayYmd: TODAY })).toMatchObject({ ok: false });
    expect(buildMarketDataRow({ fundamentals: f({ market_cap: '250000000' }), quote: q(), previous, todayYmd: TODAY })).toMatchObject({ ok: true });
  });

  test('figures for a session already on file (even a hand-checked row) are never overwritten or counted twice', () => {
    const previous = { marketCapUsd: 390_000_000, avgDailyDollarVolumeUsd: 22_000_000, asOf: '2026-11-13', sessionsAbove2B: 3 };
    const r = buildMarketDataRow({ fundamentals: f({ market_cap: '399000000' }), quote: q({ previous_close_date: '2026-11-13' }), previous, todayYmd: TODAY });
    expect(r).toEqual({ ok: true, row: previous, changed: false });
  });

  test('older figures than the ones on file never replace them', () => {
    const previous = { marketCapUsd: 390_000_000, avgDailyDollarVolumeUsd: 22_000_000, asOf: '2026-11-13' };
    const r = buildMarketDataRow({ fundamentals: f(), quote: q({ previous_close_date: '2026-11-10' }), previous, todayYmd: TODAY });
    expect(r).toEqual({ ok: true, row: previous, changed: false });
  });

  test('session counters follow the cap across the thresholds', () => {
    const previous = { marketCapUsd: 2_100_000_000, avgDailyDollarVolumeUsd: 30_000_000, asOf: '2026-11-12', sessionsAbove2B: 4 };
    const up = buildMarketDataRow({ fundamentals: f({ market_cap: '2200000000' }), quote: q(), previous, todayYmd: TODAY });
    if (!up.ok) throw new Error(up.reason);
    expect(up.row.sessionsAbove2B).toBe(5);
    expect(up.row.sessionsAbove10B).toBeUndefined();
    const down = buildMarketDataRow({ fundamentals: f({ market_cap: '1900000000' }), quote: q(), previous, todayYmd: TODAY });
    if (!down.ok) throw new Error(down.reason);
    expect(down.row.sessionsAbove2B).toBeUndefined(); // reset to zero and left out, as the file does
  });
});

describe('mergeMarketData', () => {
  test('keeps the newer row per symbol and does not change its inputs', () => {
    const a = { X: { marketCapUsd: 1, avgDailyDollarVolumeUsd: 1, asOf: '2026-11-01' }, Y: { marketCapUsd: 1, avgDailyDollarVolumeUsd: 1, asOf: '2026-11-10' } };
    const b = { X: { marketCapUsd: 2, avgDailyDollarVolumeUsd: 2, asOf: '2026-11-13' }, Y: { marketCapUsd: 2, avgDailyDollarVolumeUsd: 2, asOf: '2026-11-05' }, Z: { marketCapUsd: 3, avgDailyDollarVolumeUsd: 3, asOf: '2026-11-13' } };
    const merged = mergeMarketData(a, b);
    expect(merged.X!.marketCapUsd).toBe(2);
    expect(merged.Y!.marketCapUsd).toBe(1);
    expect(merged.Z!.marketCapUsd).toBe(3);
    expect(a.X.marketCapUsd).toBe(1);
  });
});
