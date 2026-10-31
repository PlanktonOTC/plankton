import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PRICING_CONFIG,
  E18,
  aggregate,
  confidenceBps,
  diffBps,
  dispersionBps,
  formatE18,
  formatUsdg,
  median,
  mulDiv,
  multiplierContinuous,
  notionalUsdg,
  parseE18,
  parseUnits,
  parseUsdg,
  rhMid,
  sizeFromNotionalE18,
  type Observation,
} from '../src/index.ts';

const NOW = 1_800_000_000_000;
const obs = (source: Observation['source'], price: string, ageMs = 1_000, extra: Partial<Observation> = {}): Observation => ({
  source,
  priceE18: parseE18(price),
  observedAt: NOW,
  sourceUpdatedAt: NOW - ageMs,
  ...extra,
});

describe('units', () => {
  test('decimal strings round-trip without losing precision', () => {
    expect(parseE18('344.6')).toBe(344_600_000_000_000_000_000n);
    expect(formatE18(parseE18('344.795071189052453446'), 18)).toBe('344.795071189052453446');
    expect(parseUsdg('1234.5')).toBe(1_234_500_000n);
    expect(formatUsdg(1_234_500_000n, 2)).toBe('1234.50');
    expect(parseUnits('-1.5', 6)).toBe(-1_500_000n);
    expect(formatUnits6(-1_500_000n)).toBe('-1.500000');
  });

  test('rejects text that is not a decimal number', () => {
    expect(() => parseE18('abc')).toThrow();
    expect(() => parseE18('1e5')).toThrow();
  });

  test('notional of 5 tokens at $100 is $500, in USDG units', () => {
    expect(notionalUsdg(5n * E18, 100n * E18)).toBe(500_000_000n);
    expect(notionalUsdg(-5n * E18, 100n * E18)).toBe(500_000_000n);
  });

  test('size from notional is the inverse of notional', () => {
    const size = sizeFromNotionalE18(500_000_000n, 100n * E18);
    expect(size).toBe(5n * E18);
  });

  test('diffBps measures distance as a share of the reference', () => {
    expect(diffBps(101n * E18, 100n * E18)).toBe(100n);
    expect(diffBps(99n * E18, 100n * E18)).toBe(100n);
    expect(diffBps(100n * E18, 0n)).toBeGreaterThan(1_000_000n);
  });

  test('mulDiv refuses to divide by zero', () => {
    expect(mulDiv(6n, 7n, 2n)).toBe(21n);
    expect(() => mulDiv(1n, 1n, 0n)).toThrow();
  });
});

const formatUnits6 = (v: bigint) => (v < 0n ? '-' : '') + (Number(v < 0n ? -v : v) / 1e6).toFixed(6);

describe('pricing', () => {
  test('median of odd and even sets', () => {
    expect(median([3n, 1n, 2n])).toBe(2n);
    expect(median([10n, 20n])).toBe(15n);
    expect(() => median([])).toThrow();
  });

  test('dispersion is the spread of the set as bps of its median', () => {
    expect(dispersionBps([parseE18('100'), parseE18('101')])).toBe(99n);
    expect(dispersionBps([parseE18('100')])).toBe(0n);
  });

  test('a Robinhood quote becomes a token price by multiplying the underlying mid by the multiplier', () => {
    // bid 100, ask 100.2, multiplier 1.01 -> mid 100.1 -> token price 101.101
    expect(rhMid(parseE18('100'), parseE18('100.2'), parseE18('1.01'))).toBe(parseE18('101.101'));
  });

  test('confidence is the larger of source dispersion and half the bid/ask spread', () => {
    const a = obs('chainlink', '100');
    const b = obs('rh_quote', '100.4', 1_000, { bidE18: parseE18('99'), askE18: parseE18('101.8') }); // spread 2.8% -> half 1.4%
    expect(confidenceBps([a, b])).toBe(139); // spread term dominates dispersion (~40 bps)
    expect(confidenceBps([obs('chainlink', '100'), obs('rh_quote', '100.5')])).toBe(49); // no bid/ask: dispersion only
  });

  test('two fresh sources within the threshold agree', () => {
    const r = aggregate([obs('chainlink', '100'), obs('rh_quote', '100.5')], NOW, DEFAULT_PRICING_CONFIG);
    expect(r.used).toHaveLength(2);
    expect(r.agree).toBe(true);
    expect(r.priceE18).toBe(parseE18('100.25'));
  });

  test('sources further apart than agreeBps do not agree', () => {
    const r = aggregate([obs('chainlink', '100'), obs('rh_quote', '103')], NOW, DEFAULT_PRICING_CONFIG);
    expect(r.agree).toBe(false);
  });

  test('a stale source is ignored and a single source reports the reduce-only confidence', () => {
    const cfg = DEFAULT_PRICING_CONFIG;
    const r = aggregate([obs('chainlink', '100', 100 * 3_600_000), obs('rh_quote', '100.1')], NOW, cfg); // Chainlink 100 h old
    expect(r.used.map((o) => o.source)).toEqual(['rh_quote']);
    expect(r.agree).toBe(false);
    expect(r.confidenceBps).toBe(cfg.singleSourceConfidenceBps);
  });

  test('Chainlink is allowed to be hours old because its feeds only update on moves, but not days', () => {
    const fresh = aggregate([obs('chainlink', '100', 20 * 3_600_000), obs('rh_quote', '100.1')], NOW, DEFAULT_PRICING_CONFIG);
    expect(fresh.used).toHaveLength(2);
    const dead = aggregate([obs('chainlink', '100', 30 * 3_600_000), obs('rh_quote', '100.1')], NOW, DEFAULT_PRICING_CONFIG);
    expect(dead.used).toHaveLength(1);
  });

  test('Robinhood quotes go stale after a minute', () => {
    const r = aggregate([obs('chainlink', '100'), obs('rh_quote', '100', 61_000)], NOW, DEFAULT_PRICING_CONFIG);
    expect(r.used.map((o) => o.source)).toEqual(['chainlink']);
  });

  test('a halted observation or a non-positive price is never used', () => {
    const r = aggregate([obs('chainlink', '100'), obs('rh_quote', '100', 1_000, { halted: true })], NOW, DEFAULT_PRICING_CONFIG);
    expect(r.used.map((o) => o.source)).toEqual(['chainlink']);
    expect(aggregate([{ ...obs('chainlink', '1'), priceE18: 0n }], NOW, DEFAULT_PRICING_CONFIG).priceE18).toBeNull();
  });

  test('uniswap pools carry no weight', () => {
    const r = aggregate([obs('chainlink', '100'), obs('uni_v3', '50')], NOW, DEFAULT_PRICING_CONFIG);
    expect(r.used.map((o) => o.source)).toEqual(['chainlink']);
  });

  test('only the newest observation per source counts', () => {
    const older = { ...obs('chainlink', '50'), observedAt: NOW - 10_000, sourceUpdatedAt: NOW - 5_000 };
    const newer = obs('chainlink', '100');
    const r = aggregate([older, newer, obs('rh_quote', '100')], NOW, DEFAULT_PRICING_CONFIG);
    expect(r.priceE18).toBe(parseE18('100'));
  });

  test('a 2:1 split leaves the token price continuous; a bad multiplier does not', () => {
    // underlying $200 x 1 -> after a 2:1 split: underlying $100 x multiplier 2
    const before = rhMid(parseE18('200'), parseE18('200'), parseE18('1'));
    const after = rhMid(parseE18('100'), parseE18('100'), parseE18('2'));
    expect(multiplierContinuous(before, after)).toBe(true);
    const wrong = rhMid(parseE18('100'), parseE18('100'), parseE18('1'));
    expect(multiplierContinuous(before, wrong)).toBe(false);
  });
});
