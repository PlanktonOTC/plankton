import { describe, expect, test } from 'bun:test';
import { isLiquidatable, notionalUsdg } from '@plankton/core';
import { collateralShortfall, liquidationPriceE18, positionAfterOpen, positionValue, solveOpenSize, targetNotional, type QuoteAttempt } from '../src/views.ts';

const E18 = 10n ** 18n;
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const px = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const tok = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe('positionValue', () => {
  test('a long gains when the mark rises and the maintenance requirement follows notional', () => {
    const v = positionValue({ sizeE18: tok(10), entryE18: px(100), marginUsdg: usd(500) }, px(110), 500);
    expect(v.notionalUsdg).toBe(usd(1100));
    expect(v.pnlUsdg).toBe(usd(100));
    expect(v.equityUsdg).toBe(usd(600));
    expect(v.maintenanceUsdg).toBe(usd(55)); // 5% of 1100
    expect(v.bufferUsdg).toBe(usd(545));
  });

  test('a short loses when the mark rises', () => {
    const v = positionValue({ sizeE18: -tok(10), entryE18: px(100), marginUsdg: usd(500) }, px(110), 500);
    expect(v.pnlUsdg).toBe(-usd(100));
    expect(v.equityUsdg).toBe(usd(400));
  });
});

describe('liquidationPriceE18', () => {
  const long = { sizeE18: tok(10), entryE18: px(100), marginUsdg: usd(333.333333) }; // about 3x
  const short = { sizeE18: -tok(10), entryE18: px(100), marginUsdg: usd(333.333333) };

  test('is below entry for a long and above entry for a short', () => {
    expect(liquidationPriceE18(long, 500)! < px(100)).toBe(true);
    expect(liquidationPriceE18(short, 500)! > px(100)).toBe(true);
  });

  test('matches the core liquidation test: safe just on the safe side, liquidatable just past it', () => {
    for (const p of [long, short]) {
      const liq = liquidationPriceE18(p, 500)!;
      const lp = { maintenanceMarginBps: 500 };
      const view = { sizeE18: p.sizeE18, entryE18: p.entryE18, marginUsdg: p.marginUsdg };
      const safe = p.sizeE18 > 0n ? liq + px(0.5) : liq - px(0.5);
      const gone = p.sizeE18 > 0n ? liq - px(0.5) : liq + px(0.5);
      expect(isLiquidatable(view, safe, lp)).toBe(false);
      expect(isLiquidatable(view, gone, lp)).toBe(true);
    }
  });

  test('more margin moves the liquidation price further away', () => {
    const thin = liquidationPriceE18({ ...long, marginUsdg: usd(200) }, 500)!;
    const thick = liquidationPriceE18({ ...long, marginUsdg: usd(600) }, 500)!;
    expect(thick < thin).toBe(true);
  });

  test('a heavily margined long cannot be liquidated by price alone: floors at zero', () => {
    expect(liquidationPriceE18({ sizeE18: tok(1), entryE18: px(100), marginUsdg: usd(1000) }, 500)).toBe(0n);
  });

  test('flat position has no liquidation price', () => {
    expect(liquidationPriceE18({ sizeE18: 0n, entryE18: 0n, marginUsdg: 0n }, 500)).toBeNull();
  });
});

describe('positionAfterOpen', () => {
  test('flat: the new position is the trade', () => {
    const p = positionAfterOpen({ sizeE18: 0n, entryE18: 0n, marginUsdg: 0n }, tok(5), px(20), usd(30))!;
    expect(p).toEqual({ sizeE18: tok(5), entryE18: px(20), marginUsdg: usd(30) });
  });

  test('same side: size and margin add, entry is the size-weighted average', () => {
    const p = positionAfterOpen({ sizeE18: tok(10), entryE18: px(100), marginUsdg: usd(300) }, tok(10), px(120), usd(200))!;
    expect(p.sizeE18).toBe(tok(20));
    expect(p.entryE18).toBe(px(110));
    expect(p.marginUsdg).toBe(usd(500));
  });

  test('opposite side is a reduce or flip: no estimate', () => {
    expect(positionAfterOpen({ sizeE18: tok(10), entryE18: px(100), marginUsdg: usd(300) }, -tok(4), px(100), 0n)).toBeNull();
  });
});

describe('targetNotional', () => {
  test('margin times leverage, shaved one basis point so exactly-max passes', () => {
    expect(targetNotional(usd(100), '3')).toBe(usd(299.97));
    expect(targetNotional(usd(100), '2.5')).toBe(usd(249.975));
    expect(targetNotional(usd(100), '1')).toBe(usd(99.99));
  });

  test('ignores digits beyond three decimals', () => {
    expect(targetNotional(usd(1000), '2.00099')).toBe(targetNotional(usd(1000), '2.000'));
  });
});

describe('solveOpenSize', () => {
  // A stand-in for the quote builder and the contract: leverage is checked at the mark (builder) AND at the fill price (contract).
  const MARK = px(50);
  const model = (spreadBps: number, margin: bigint, maxLev: number) => (size: bigint): QuoteAttempt => {
    const buy = size > 0n;
    const exec = (MARK * BigInt(10_000 + (buy ? spreadBps : -spreadBps))) / 10_000n;
    const cap = margin * BigInt(maxLev);
    if (notionalUsdg(size, MARK) > cap) return { result: { ok: false, code: 'leverage_exceeded', message: 'at the mark' } };
    if (notionalUsdg(size, exec) > cap) return { result: { ok: false, code: 'leverage_exceeded', message: 'at the fill' }, execPriceE18: exec };
    return { result: { ok: true, execPriceE18: exec, feeUsdg: 0n, notionalUsdg: notionalUsdg(size, exec), maxLeverageE18: BigInt(maxLev) * E18, reducing: false, spreadBps }, execPriceE18: exec };
  };

  test('a long with a wide spread at max leverage is sized from the fill price, so it is accepted (the weekend case)', () => {
    const margin = usd(100);
    const { sizeDeltaE18, result } = solveOpenSize(model(150, margin, 2), 'long', targetNotional(margin, '2'), MARK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sizeDeltaE18 > 0n).toBe(true);
    expect(result.notionalUsdg <= margin * 2n).toBe(true);
    // ...and as large as the limit allows: within two basis points of the target
    expect(result.notionalUsdg * 10_000n >= targetNotional(margin, '2') * 9_998n).toBe(true);
  });

  test('a short is held by the mark, not the fill price: it keeps its full size', () => {
    const margin = usd(100);
    const { sizeDeltaE18, result } = solveOpenSize(model(150, margin, 3), 'short', targetNotional(margin, '3'), MARK);
    expect(sizeDeltaE18 < 0n).toBe(true);
    expect(result.ok).toBe(true);
    expect(notionalUsdg(sizeDeltaE18, MARK) <= margin * 3n).toBe(true);
    expect(notionalUsdg(sizeDeltaE18, MARK) * 10_000n >= targetNotional(margin, '3') * 9_999n).toBe(true);
  });

  test('with no spread the first guess is already right', () => {
    const margin = usd(100);
    const { result } = solveOpenSize(model(0, margin, 3), 'long', targetNotional(margin, '3'), MARK);
    expect(result.ok).toBe(true);
  });

  test('a refusal that no size can fix comes back as the refusal, not a thrown error', () => {
    const refuse = (): QuoteAttempt => ({ result: { ok: false, code: 'no_capacity', message: 'full' } });
    const { result } = solveOpenSize(refuse, 'long', usd(100), MARK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_capacity');
  });
});

describe('collateralShortfall', () => {
  test('an open needs margin plus fee; a reduce needs only the fee', () => {
    expect(collateralShortfall(usd(100), usd(0.3), false, usd(40))).toBe(usd(60.3));
    expect(collateralShortfall(usd(100), usd(0.3), true, usd(0.1))).toBe(usd(0.2));
  });

  test('enough collateral means no shortfall', () => {
    expect(collateralShortfall(usd(100), usd(0.3), false, usd(500))).toBe(0n);
  });
});
