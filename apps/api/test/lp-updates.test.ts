import { describe, expect, test } from 'bun:test';
import { dailyDue, dailyText, lpText, pctChange, poolText, type PoolView } from '../src/lp-updates.ts';

// 700 USDG pool, 700e9 shares, share price $1.0012 now, $1.0000 a day ago, $0.9950 a week ago.
const pool: PoolView = {
  navUsdg: 700_840_000n,
  navPerShareE18: 1_001_200_000_000_000n,
  totalShares: 700_000_000_000n,
  pps24hAgo: 1_000_000_000_000_000n,
  pps7dAgo: 995_000_000_000_000n,
};

describe('LP updates', () => {
  test('percent change is signed and absent without history', () => {
    expect(pctChange(1_001_200n, 1_000_000n)).toBe('+0.12%');
    expect(pctChange(990_000n, 1_000_000n)).toBe('-1.00%');
    expect(pctChange(1n, null)).toBeNull();
  });

  test('/pool shows value, share price and both changes', () => {
    expect(poolText(pool)).toContain('Pool value: $700.84');
    expect(poolText(pool)).toContain('Share price: 1.0012 · 24h +0.12% · 7d +0.62%');
    expect(poolText({ ...pool, pps24hAgo: null, pps7dAgo: null })).toContain('Share price: 1.0012\n');
  });

  test('/lp shows the holder their value, pool share and 24h change in dollars', () => {
    const text = lpText(pool, 350_000_000_000n);
    expect(text).toContain('Value: $350.42 · 50.00% of the pool');
    expect(text).toContain('24h: +$0.42 (+0.12%)');
    expect(lpText({ ...pool, pps24hAgo: 1_002_000_000_000_000n }, 350_000_000_000n)).toContain('24h: -$0.28 (-0.08%)');
    expect(lpText(pool, 0n)).toContain('holds no Counter shares');
  });

  test('the daily summary carries the position and the pool, and how to stop it', () => {
    const text = dailyText(pool, 700_000_000_000n);
    expect(text).toContain('Daily LP summary');
    expect(text).toContain('Value: $700.84 · 100.00% of the pool');
    expect(text).toContain('Pool value: $700.84');
    expect(text).toContain('/daily off');
  });

  test('it is due once per New York weekday, after 17:00 ET', () => {
    const at = (iso: string) => Date.parse(iso);
    // Wednesday 2026-11-18, EST (UTC-5).
    expect(dailyDue(at('2026-11-18T21:59:00Z'), null)).toEqual({ due: false, ymd: '2026-11-18' }); // 16:59 ET
    expect(dailyDue(at('2026-11-18T22:00:00Z'), null)).toEqual({ due: true, ymd: '2026-11-18' }); // 17:00 ET
    expect(dailyDue(at('2026-11-18T23:30:00Z'), '2026-11-18').due).toBe(false); // already sent today
    expect(dailyDue(at('2026-11-19T04:30:00Z'), '2026-11-18').due).toBe(false); // 23:30 ET same day
    expect(dailyDue(at('2026-11-21T22:30:00Z'), '2026-11-20').due).toBe(false); // Saturday
  });
});
