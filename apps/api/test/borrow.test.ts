import { describe, expect, test } from 'bun:test';
import { borrowRates } from '../src/quote.ts';

const base = { nav: 10_000n, baseBps: 4n, netSkewBpsOfV: 2_000n, grossOiBpsOfV: 5_000n, absOiCapUsdg: 0n };

describe('borrowRates', () => {
  test('charges the dominant side by the squared net-skew ratio', () => {
    expect(borrowRates({ ...base, longOi: 1_000n, shortOi: 0n })).toEqual({ long: 1, short: 0 });
    expect(borrowRates({ ...base, baseBps: 1n, longOi: 1_000n, shortOi: 0n })).toEqual({ long: 0.25, short: 0 });
  });

  test('above 80% of gross capacity both sides pay at least the base rate', () => {
    expect(borrowRates({ ...base, longOi: 3_000n, shortOi: 1_500n })).toEqual({ long: 4, short: 4 });
  });

  test('balanced utilization below the threshold does not accrue borrow', () => {
    expect(borrowRates({ ...base, longOi: 1_000n, shortOi: 1_000n })).toEqual({ long: 0, short: 0 });
  });
});
