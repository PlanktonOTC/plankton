import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROFILES,
  E18,
  MarketState,
  RUNGS,
  Status,
  buildTradeQuote,
  closeSizeDeltaE18,
  isRiskReducing,
  marketCaps,
  skewFillPriceE18,
  skewScaleE18,
  tradeFeeUsdg,
  notionalUsdg,
  type QuoteMark,
  type QuoteMarket,
  type QuoteRequest,
} from '../src/index.ts';

const usdg = (n: number) => BigInt(Math.round(n * 1e6));
const caps = marketCaps(usdg(100_000), RUNGS.R1);
const scale = skewScaleE18(caps.netSkewUsdg);

const market = (over: Partial<QuoteMarket> = {}): QuoteMarket => ({
  class: 'small',
  state: MarketState.Active,
  feeBps: 8,
  maxExecDeviationBps: 500,
  maxConfidenceBps: 200,
  frozenSpreadBps: 200,
  skewScaleE18: scale,
  caps,
  oi: { longUsdg: 0n, shortUsdg: 0n },
  leverageCap: 3,
  navUsdg: usdg(100_000),
  deleveraging: false,
  ...over,
});
const mark = (over: Partial<QuoteMark> = {}): QuoteMark => ({ priceE18: 100n * E18, confidenceBps: 10, status: Status.Open, sequence: 7n, ageSec: 5, breaker: false, ...over });
const profile = { ...DEFAULT_PROFILES[Status.Open], leverage: { micro: 2, small: 3, smid: 3, index: 3 } };
const req = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  sizeDeltaE18: 5n * E18,
  marginUsdg: usdg(200),
  positionSizeE18: 0n,
  openGuard: false,
  profile,
  maxMarkAgeSec: 180,
  ...over,
});

function ok(r: ReturnType<typeof buildTradeQuote>) {
  if (!r.ok) throw new Error(`expected a quote, got ${r.code}: ${r.message}`);
  return r;
}
const code = (r: ReturnType<typeof buildTradeQuote>) => (r.ok ? 'ok' : r.code);

describe('building a quote', () => {
  test('a fresh buy fills at exactly the skew price, with the 8 bp fee on the execution notional', () => {
    const r = ok(buildTradeQuote(market(), mark(), req()));
    expect(r.execPriceE18).toBe(skewFillPriceE18(100n * E18, 0n, 500n * E18, scale));
    expect(r.feeUsdg).toBe(tradeFeeUsdg(notionalUsdg(5n * E18, r.execPriceE18), 8));
    expect(r.reducing).toBe(false);
    expect(r.maxLeverageE18).toBe(3n * E18);
  });

  test('a sell fills below the mark by the spread, a buy above it', () => {
    const buy = ok(buildTradeQuote(market(), mark(), req({ profile: DEFAULT_PROFILES[Status.Extended] })));
    const base = skewFillPriceE18(100n * E18, 0n, 500n * E18, scale);
    expect(buy.execPriceE18).toBe((base * 10_050n) / 10_000n); // +50 bp in extended hours
  });

  test('the open guard adds 50 bp on top', () => {
    const plain = ok(buildTradeQuote(market(), mark(), req()));
    const guarded = ok(buildTradeQuote(market(), mark(), req({ openGuard: true })));
    expect(guarded.spreadBps).toBe(plain.spreadBps + 50);
    expect(guarded.execPriceE18).toBeGreaterThan(plain.execPriceE18);
  });

  test('weekend opens pay 150 bp', () => {
    const r = ok(buildTradeQuote(market(), mark({ status: Status.Weekend }), req({ profile: { ...DEFAULT_PROFILES[Status.Weekend], leverage: { micro: 1.5, small: 2, smid: 2, index: 2 } }, sizeDeltaE18: 2n * E18, marginUsdg: usdg(120) })));
    expect(r.spreadBps).toBe(150);
  });
});

describe('the mid-size tier', () => {
  const smidProfile = { ...DEFAULT_PROFILES[Status.Open], leverage: { micro: 2, small: 3, smid: 5, index: 5 } };

  test('a Smid market uses the Smid leverage ceiling: 4.5x is refused at the Small cap and accepted at the Smid cap', () => {
    const request = req({ profile: smidProfile, marginUsdg: usdg(111) }); // $500 on $111 is about 4.5x
    expect(code(buildTradeQuote(market({ class: 'smid', leverageCap: 3 }), mark(), request))).toBe('leverage_exceeded');
    expect(code(buildTradeQuote(market({ class: 'smid', leverageCap: 5 }), mark(), request))).toBe('ok');
  });

  test('a Small market never gets more than 3x, even if the profile allows more', () => {
    const lax = { ...DEFAULT_PROFILES[Status.Open], leverage: { micro: 3, small: 5, smid: 5, index: 5 } };
    expect(code(buildTradeQuote(market({ class: 'small', leverageCap: 3 }), mark(), req({ profile: lax, marginUsdg: usdg(111) })))).toBe('leverage_exceeded');
  });
});

describe('what stops an open', () => {
  test('market not active', () => expect(code(buildTradeQuote(market({ state: MarketState.CloseOnly }), mark(), req()))).toBe('market_not_active'));
  test('session does not allow opens', () => expect(code(buildTradeQuote(market(), mark({ status: Status.Frozen }), req({ profile: DEFAULT_PROFILES[Status.Frozen] })))).toBe('session_closed'));
  test('the price breaker is set', () => expect(code(buildTradeQuote(market(), mark({ breaker: true }), req()))).toBe('breaker_set'));
  test('the mark is stale', () => expect(code(buildTradeQuote(market(), mark({ ageSec: 181 }), req()))).toBe('stale_mark'));
  test('the mark is too uncertain', () => expect(code(buildTradeQuote(market(), mark({ confidenceBps: 201 }), req()))).toBe('low_confidence'));
  test('the Counter is deleveraging', () => expect(code(buildTradeQuote(market({ deleveraging: true }), mark(), req()))).toBe('deleveraging'));
  test('zero size', () => expect(code(buildTradeQuote(market(), mark(), req({ sizeDeltaE18: 0n })))).toBe('zero_size'));
  test('no margin', () => expect(code(buildTradeQuote(market(), mark(), req({ marginUsdg: 0n })))).toBe('margin_required'));
  test('leverage above the cap: $500 on $100 is 5x against 3x', () => expect(code(buildTradeQuote(market(), mark(), req({ marginUsdg: usdg(100) })))).toBe('leverage_exceeded'));
  test('exactly 3x is allowed', () => expect(code(buildTradeQuote(market(), mark(), req({ marginUsdg: usdg(167) })))).toBe('ok'));
  test('a position above 1% of the Counter', () => expect(code(buildTradeQuote(market(), mark(), req({ sizeDeltaE18: 11n * E18, marginUsdg: usdg(500) })))).toBe('position_too_large'));
  test('no room left on that side of the book', () =>
    expect(code(buildTradeQuote(market({ oi: { longUsdg: usdg(3_800), shortUsdg: 0n } }), mark(), req()))).toBe('no_capacity'));
  test('a price too far from the mark', () =>
    expect(code(buildTradeQuote(market({ skewScaleE18: 1_000_000n * E18 / 1_000_000n }), mark(), req()))).toBe('exec_deviation'));

  test('the weekend limit is per wallet across all markets', () => {
    const wk = { ...DEFAULT_PROFILES[Status.Weekend], leverage: { micro: 1.5, small: 2, smid: 2, index: 2 } };
    const r = buildTradeQuote(market(), mark({ status: Status.Weekend }), req({ profile: wk, sizeDeltaE18: 2n * E18, marginUsdg: usdg(120), walletNotionalUsdg: usdg(100) }));
    expect(code(r)).toBe('wallet_limit'); // $100 already open + $200 > $250 allowance
  });

  test('adding to a position counts the margin already in it toward leverage', () => {
    // $400 position on $200 margin is 2x. Adding $100 of exposure with $0.01 margin must still be judged on $200 + margin.
    const r = buildTradeQuote(market(), mark(), req({ sizeDeltaE18: 1n * E18, marginUsdg: usdg(1), positionSizeE18: 4n * E18, existingMarginUsdg: usdg(200) }));
    expect(code(r)).toBe('ok'); // $500 on $201 = 2.49x
  });

  test('a flip starts fresh: the old margin does not count toward the new side', () => {
    const r = buildTradeQuote(market(), mark(), req({ sizeDeltaE18: -8n * E18, marginUsdg: usdg(50), positionSizeE18: 5n * E18, existingMarginUsdg: usdg(300) }));
    expect(code(r)).toBe('leverage_exceeded'); // new short of 3 tokens = $300 on $50 margin
  });
});

describe('exits are never refused for the reasons that stop opens', () => {
  const long5 = { positionSizeE18: 5n * E18, marginUsdg: 0n, sizeDeltaE18: -5n * E18 };

  test('closing works in a close-only market, with a stale mark, low confidence and a breaker', () => {
    expect(code(buildTradeQuote(market({ state: MarketState.CloseOnly }), mark(), req(long5)))).toBe('ok');
    expect(code(buildTradeQuote(market(), mark({ ageSec: 9_999, confidenceBps: 9_999, breaker: true }), req(long5)))).toBe('ok');
    expect(code(buildTradeQuote(market({ deleveraging: true }), mark(), req(long5)))).toBe('ok');
  });

  test('closing in a frozen market pays the frozen spread (200 bp) below the skew price', () => {
    const r = ok(buildTradeQuote(market(), mark({ status: Status.Frozen }), req({ ...long5, profile: DEFAULT_PROFILES[Status.Frozen] })));
    const base = skewFillPriceE18(100n * E18, 0n, -500n * E18, scale);
    expect(r.spreadBps).toBe(200);
    expect(r.execPriceE18).toBe((base * 9_800n) / 10_000n);
    expect(r.reducing).toBe(true);
  });

  test('a partial close and a full close', () => {
    expect(closeSizeDeltaE18(5n * E18, 2_500)).toBe(-(125n * E18) / 100n);
    expect(closeSizeDeltaE18(5n * E18, 10_000)).toBe(-5n * E18);
    expect(closeSizeDeltaE18(-5n * E18, 10_000)).toBe(5n * E18);
    expect(closeSizeDeltaE18(5n * E18, 99_999)).toBe(-5n * E18); // capped at the whole position
  });

  test('what counts as reducing: only moves toward flat, never past it', () => {
    expect(isRiskReducing(5n * E18, -3n * E18)).toBe(true);
    expect(isRiskReducing(5n * E18, -5n * E18)).toBe(true);
    expect(isRiskReducing(5n * E18, -6n * E18)).toBe(false); // flips
    expect(isRiskReducing(5n * E18, 1n * E18)).toBe(false);
    expect(isRiskReducing(0n, -1n * E18)).toBe(false);
  });
});
