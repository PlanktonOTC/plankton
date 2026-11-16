import { describe, expect, test } from 'bun:test';
import { e18ToDecimal, feedRow } from '../src/feed.ts';

const id = `0x${'ab'.repeat(32)}` as const;
const mark = (over: Partial<Parameters<typeof feedRow>[3]> = {}) => ({
  priceE18: 4_015_500_000_000_000_000n,
  confidenceBps: 20,
  status: 1,
  sequence: 7n,
  updatedAt: 1_000n,
  breaker: false,
  ...over,
});

describe('e18ToDecimal', () => {
  test('formats and truncates', () => {
    expect(e18ToDecimal(4_015_500_000_000_000_000n)).toBe('4.015500');
    expect(e18ToDecimal(1_999_999_999_999_999_999n)).toBe('1.999999');
    expect(e18ToDecimal(50_000_000_000_000n)).toBe('0.000050');
    expect(e18ToDecimal(0n)).toBe('0.000000');
  });
});

describe('feedRow', () => {
  test('a normal open mark', () => {
    const r = feedRow('RCAT', 'small', id, mark(), 1_042n);
    expect(r).toMatchObject({ symbol: 'RCAT', price: '4.015500', status: 'open', ageSec: 42, fresh: true, sequence: '7' });
    expect(r.priceE18).toBe('4015500000000000000');
  });
  test('a market that was never priced', () => {
    const r = feedRow('TE', 'small', id, mark({ priceE18: 0n, status: 0, updatedAt: 0n, sequence: 0n }), 1_042n);
    expect(r).toMatchObject({ price: null, status: 'unset', ageSec: null, fresh: false });
  });
  test('breaker tripped is not fresh', () => {
    expect(feedRow('X', 'small', id, mark({ breaker: true }), 1_042n).fresh).toBe(false);
  });
  test('an observation slightly ahead of the chain clock has age 0', () => {
    expect(feedRow('X', 'small', id, mark({ updatedAt: 1_045n }), 1_042n).ageSec).toBe(0);
  });
  test('an old price is still shown but not fresh', () => {
    const r = feedRow('X', 'small', id, mark({ updatedAt: 1_000n }), 1_000n + 301n);
    expect(r).toMatchObject({ price: '4.015500', ageSec: 301, fresh: false });
    expect(feedRow('X', 'small', id, mark({ updatedAt: 1_000n }), 1_000n + 300n).fresh).toBe(true);
  });
  test('unknown status number maps to unset', () => {
    expect(feedRow('X', 'small', id, mark({ status: 9 }), 1_042n).status).toBe('unset');
  });
});
