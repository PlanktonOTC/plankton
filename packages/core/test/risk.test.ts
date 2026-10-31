import { describe, expect, test } from 'bun:test';
import {
  E18,
  RUNGS,
  capacity,
  dominantBorrowBpsPerHour,
  halveCaps,
  hourlyProfitLimitUsdg,
  isDeleveraging,
  isLiquidatable,
  liquidationPenalty,
  marketCaps,
  minHoldProfitCapUsdg,
  minimumBorrowApplies,
  netSkewBpsFromBudget,
  skewFillPriceE18,
  skewScaleE18,
  splitFee,
  stressNavUsdg,
  tradeFeeUsdg,
  unrealizedPnlUsdg,
} from '../src/index.ts';

const usdg = (n: number) => BigInt(Math.round(n * 1e6));

describe('caps come from the Counter, rung by rung', () => {
  test('R0 at $50K: net skew $2K, gross OI $6K, max position $500, total net $10K', () => {
    expect(marketCaps(usdg(50_000), RUNGS.R0)).toEqual({ netSkewUsdg: usdg(2_000), grossOiUsdg: usdg(6_000), positionUsdg: usdg(500), totalNetUsdg: usdg(10_000) });
  });
  test('R1 at $100K: $4K / $12K / $1K', () => {
    const c = marketCaps(usdg(100_000), RUNGS.R1);
    expect([c.netSkewUsdg, c.grossOiUsdg, c.positionUsdg]).toEqual([usdg(4_000), usdg(12_000), usdg(1_000)]);
  });
  test('R2 at $250K: $10K / $30K / $2.5K', () => {
    const c = marketCaps(usdg(250_000), RUNGS.R2);
    expect([c.netSkewUsdg, c.grossOiUsdg, c.positionUsdg]).toEqual([usdg(10_000), usdg(30_000), usdg(2_500)]);
  });
  test('R3 uses 5% / 15% / 1.5%', () => {
    const c = marketCaps(usdg(1_000_000), RUNGS.R3);
    expect([c.netSkewUsdg, c.grossOiUsdg, c.positionUsdg]).toEqual([usdg(50_000), usdg(150_000), usdg(15_000)]);
  });
  test('the absolute ceiling (1% of daily dollar volume) can only lower gross OI', () => {
    expect(marketCaps(usdg(100_000), RUNGS.R1, usdg(5_000)).grossOiUsdg).toBe(usdg(5_000));
    expect(marketCaps(usdg(100_000), RUNGS.R1, usdg(50_000)).grossOiUsdg).toBe(usdg(12_000));
  });
  test('net skew is the gap budget divided by the stress gap: 2% / 50% = 4%', () => {
    expect(netSkewBpsFromBudget(200, 5_000)).toBe(400);
  });
  test('the ladder is wider rung by rung', () => {
    expect(RUNGS.R0.maxMarkets).toBe(4);
    expect(RUNGS.R4.maxMarkets).toBe(64);
    expect(RUNGS.R0.leverage).toMatchObject({ micro: 2, small: 3, smid: 3 });
  });
  test('Small stays at 2-3x on every rung; Smid reaches 5x from R1 (expansion plan)', () => {
    for (const rung of ['R0', 'R1', 'R2', 'R3', 'R4'] as const) expect(RUNGS[rung].leverage.small).toBeLessThanOrEqual(3);
    expect(RUNGS.R1.leverage.smid).toBe(5);
  });
});

describe('capacity', () => {
  const caps = marketCaps(usdg(100_000), RUNGS.R1);

  test('an empty book has the full net skew cap on both sides', () => {
    expect(capacity({ longUsdg: 0n, shortUsdg: 0n }, caps)).toEqual({ longRoomUsdg: usdg(4_000), shortRoomUsdg: usdg(4_000) });
  });
  test('a long-heavy book has less room to go long and more to go short', () => {
    expect(capacity({ longUsdg: usdg(1_000), shortUsdg: 0n }, caps)).toEqual({ longRoomUsdg: usdg(3_000), shortRoomUsdg: usdg(5_000) });
  });
  test('gross open interest limits both sides even when the book is balanced', () => {
    expect(capacity({ longUsdg: usdg(5_900), shortUsdg: usdg(5_900) }, caps)).toEqual({ longRoomUsdg: usdg(200), shortRoomUsdg: usdg(200) });
  });
  test('room never goes negative', () => {
    expect(capacity({ longUsdg: usdg(9_000), shortUsdg: 0n }, caps).longRoomUsdg).toBe(0n);
  });
  test('the all-markets net budget limits a trade that adds exposure, but not one that reduces it', () => {
    const r = capacity({ longUsdg: 0n, shortUsdg: usdg(1_000) }, caps, usdg(500));
    expect(r.shortRoomUsdg).toBe(usdg(500)); // adds to exposure: only $500 of the global budget left
    expect(r.longRoomUsdg).toBe(usdg(1_500)); // first $1,000 reduces the short for free, then $500 more
  });
  test('deleverage mode halves every cap, and trips only after 72 hours', () => {
    expect(halveCaps(caps).netSkewUsdg).toBe(usdg(2_000));
    expect(isDeleveraging(72 * 3_600)).toBe(false);
    expect(isDeleveraging(72 * 3_600 + 1)).toBe(true);
  });
});

describe('skew pricing (SIP-279 style)', () => {
  const cap = usdg(4_000);
  const scale = skewScaleE18(cap);

  test('a trade from flat to the net-skew cap pays about 0.75% on average', () => {
    const fill = skewFillPriceE18(100n * E18, 0n, 4_000n * E18, scale);
    const impactBps = Number((fill - 100n * E18) * 10_000n / (100n * E18));
    expect(impactBps).toBe(75);
  });
  test('buying into a long-heavy book pays a premium over the mark', () => {
    expect(skewFillPriceE18(100n * E18, 2_000n * E18, 2_500n * E18, scale)).toBeGreaterThan(100n * E18);
  });
  test('selling out of a long-heavy book earns a rebate: the seller is paid above the mark', () => {
    expect(skewFillPriceE18(100n * E18, 2_000n * E18, 1_500n * E18, scale)).toBeGreaterThan(100n * E18);
  });
  test('selling into a short-heavy book pays less than the mark; buying out of it is cheaper', () => {
    expect(skewFillPriceE18(100n * E18, -2_000n * E18, -2_500n * E18, scale)).toBeLessThan(100n * E18); // adds to the short skew
    expect(skewFillPriceE18(100n * E18, -2_000n * E18, -1_000n * E18, scale)).toBeLessThan(100n * E18); // buyer reduces it, pays less
  });
  test('with no scale the mark is used as it is', () => {
    expect(skewFillPriceE18(100n * E18, 0n, 1_000n * E18, 0n)).toBe(100n * E18);
  });
});

describe('fees', () => {
  test('8 bp on $500 is $0.40', () => {
    expect(tradeFeeUsdg(usdg(500), 8)).toBe(400_000n);
  });

  test('v1 split: Counter 75%, Backstop 20%, treasury 5%', () => {
    const s = splitFee(1_000_000n, 'v1');
    expect(s).toEqual({ referralUsdg: 0n, counterUsdg: 750_000n, backstopUsdg: 200_000n, juniorUsdg: 0n, treasuryUsdg: 50_000n });
  });
  test('v2 split: Counter 65%, Backstop 10%, First-Loss 15%, treasury 10%', () => {
    const s = splitFee(1_000_000n, 'v2');
    expect([s.counterUsdg, s.backstopUsdg, s.juniorUsdg, s.treasuryUsdg]).toEqual([650_000n, 100_000n, 150_000n, 100_000n]);
  });
  test('a referral rebate comes off first, capped at 10%', () => {
    const s = splitFee(1_000_000n, 'v1', { referralBps: 500 });
    expect(s.referralUsdg).toBe(50_000n);
    expect(splitFee(1_000_000n, 'v1', { referralBps: 5_000 }).referralUsdg).toBe(100_000n);
  });
  test('once the Backstop Fund is full its share goes to the Counter', () => {
    const s = splitFee(1_000_000n, 'v1', { backstopAtTarget: true });
    expect([s.backstopUsdg, s.counterUsdg]).toEqual([0n, 950_000n]);
  });
  test('the pieces always add up to the fee', () => {
    for (const fee of [1n, 7n, 99_999n, 1_234_567n]) {
      for (const phase of ['v1', 'v2'] as const) {
        const s = splitFee(fee, phase, { referralBps: 300 });
        expect(s.referralUsdg + s.counterUsdg + s.backstopUsdg + s.juniorUsdg + s.treasuryUsdg).toBe(fee);
      }
    }
  });
});

describe('liquidation and limits', () => {
  const long = { sizeE18: 5n * E18, entryE18: 100n * E18, marginUsdg: usdg(170) };

  test('profit and loss on a position', () => {
    expect(unrealizedPnlUsdg(long, 110n * E18)).toBe(usdg(50));
    expect(unrealizedPnlUsdg(long, 90n * E18)).toBe(usdg(-50));
    expect(unrealizedPnlUsdg({ ...long, sizeE18: -5n * E18 }, 90n * E18)).toBe(usdg(50));
  });
  test('a $500 long with $170 margin is liquidated near $69 at 5% maintenance', () => {
    expect(isLiquidatable(long, 70n * E18, { maintenanceMarginBps: 500 })).toBe(false); // equity 20 vs 17.5
    expect(isLiquidatable(long, 68n * E18, { maintenanceMarginBps: 500 })).toBe(true); // equity 10 vs 17
  });
  test('accrued borrow can tip a position over the line', () => {
    expect(isLiquidatable(long, 70n * E18, { maintenanceMarginBps: 500, accruedBorrowUsdg: usdg(3) })).toBe(true);
  });
  test('shorts mirror longs', () => {
    const short = { ...long, sizeE18: -5n * E18 };
    expect(isLiquidatable(short, 132n * E18, { maintenanceMarginBps: 500 })).toBe(true);
    expect(isLiquidatable(short, 120n * E18, { maintenanceMarginBps: 500 })).toBe(false);
  });
  test('a flat position is never liquidated', () => {
    expect(isLiquidatable({ ...long, sizeE18: 0n }, 1n * E18, { maintenanceMarginBps: 500 })).toBe(false);
  });
  test('the penalty is 5% of margin, split evenly between the liquidator and the Backstop Fund', () => {
    expect(liquidationPenalty(usdg(170))).toEqual({ liquidatorUsdg: 4_250_000n, backstopUsdg: 4_250_000n, totalUsdg: 8_500_000n });
  });
  test('stress test: every market gaps 25% against the Counter on its net side', () => {
    expect(stressNavUsdg(usdg(100_000), [usdg(3_000), usdg(-1_000)], 2_500)).toEqual({ stressNavUsdg: usdg(99_000), lossUsdg: usdg(1_000) });
  });
  test('payout limits: 2% of the Counter per hour, and 25 bp of notional for a quick profit', () => {
    expect(hourlyProfitLimitUsdg(usdg(100_000))).toBe(usdg(2_000));
    expect(minHoldProfitCapUsdg(usdg(550))).toBe(1_375_000n);
  });
  test('borrow: the crowded side pays base x (net / maxNet) squared, capped at base', () => {
    expect(dominantBorrowBpsPerHour(2, usdg(4_000), usdg(4_000))).toBe(2);
    expect(dominantBorrowBpsPerHour(2, usdg(2_000), usdg(4_000))).toBe(0.5);
    expect(dominantBorrowBpsPerHour(2, usdg(9_000), usdg(4_000))).toBe(2);
    expect(dominantBorrowBpsPerHour(2, usdg(1), 0n)).toBe(0);
  });
  test('the minimum borrow switches on above 80% of the gross cap', () => {
    expect(minimumBorrowApplies(usdg(9_700), usdg(12_000))).toBe(true);
    expect(minimumBorrowApplies(usdg(9_600), usdg(12_000))).toBe(false);
  });
});
