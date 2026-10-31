import { describe, expect, test } from 'bun:test';
import { DEFAULT_PRICING_CONFIG, Status, checkEligibility, newEngineState, parseE18, stepMark, type MarketData, type Observation } from '../src/index.ts';

const NOW = Date.UTC(2026, 10, 10);
const good: MarketData = { marketCapUsd: 900_000_000, avgDailyDollarVolumeUsd: 25_000_000, asOf: '2026-11-05' };
const smidData: MarketData = { ...good, marketCapUsd: 3_000_000_000 };

describe('the listing rule: basics for every tier', () => {
  test('a small cap with real volume and a normal price is eligible, with 1% of volume as its open-interest ceiling', () => {
    const r = checkEligibility('NNE', 'small', good, 18.4, NOW);
    expect(r).toEqual({ symbol: 'NNE', eligible: true, reasons: [], warnings: [], absOiCapUsdg: 250_000_000_000n }); // 1% of $25M = $250,000
  });

  test('volume must reach $2M a day', () => {
    expect(checkEligibility('X', 'small', { ...good, avgDailyDollarVolumeUsd: 1_999_999 }, 10, NOW).reasons).toEqual(['average daily dollar volume is under $2M']);
    expect(checkEligibility('X', 'small', { ...good, avgDailyDollarVolumeUsd: 2_000_000 }, 10, NOW).eligible).toBe(true);
    expect(checkEligibility('X', 'smid', { ...smidData, avgDailyDollarVolumeUsd: 100 }, 10, NOW).eligible).toBe(false);
  });

  test('price must be at least $1, and an unknown price does not fail the rule on its own', () => {
    expect(checkEligibility('X', 'small', good, 0.99, NOW).reasons).toEqual(['price is under $1']);
    expect(checkEligibility('X', 'smid', smidData, 0.5, NOW).reasons).toEqual(['price is under $1']);
    expect(checkEligibility('X', 'small', good, 1, NOW).eligible).toBe(true);
    expect(checkEligibility('X', 'small', good, null, NOW).eligible).toBe(true);
  });

  test('no data, or data older than two weeks, is a failure: we never list on a guess', () => {
    expect(checkEligibility('X', 'small', undefined, 10, NOW).reasons).toEqual(['no market data on file']);
    expect(checkEligibility('X', 'smid', undefined, 10, NOW).eligible).toBe(false);
    expect(checkEligibility('X', 'small', { ...good, asOf: '2026-10-26' }, 10, NOW).reasons[0]).toContain('15 days old');
    expect(checkEligibility('X', 'small', { ...good, asOf: '2026-10-27' }, 10, NOW).eligible).toBe(true); // exactly 14 days is still fine
    expect(checkEligibility('X', 'small', { ...good, asOf: 'yesterday' }, 10, NOW).reasons).toContain('market data date is not valid');
  });
});

describe('the size tiers', () => {
  test('a micro tag needs a cap under $300M', () => {
    expect(checkEligibility('X', 'micro', { ...good, marketCapUsd: 250_000_000 }, 10, NOW).eligible).toBe(true);
    expect(checkEligibility('X', 'micro', good, 10, NOW).reasons).toEqual(['tagged micro but market cap is not under $300M']);
  });

  test('Small: under $2B is clean; above it the name stays listed with a warning until it has been above for 20 sessions', () => {
    const over = { ...good, marketCapUsd: 2_400_000_000 };
    const fresh = checkEligibility('X', 'small', over, 10, NOW);
    expect(fresh.eligible).toBe(true);
    expect(fresh.warnings[0]).toContain('above $2B (0/20 sessions)');
    expect(checkEligibility('X', 'small', { ...over, sessionsAbove2B: 19 }, 10, NOW).eligible).toBe(true);
    const due = checkEligibility('X', 'small', { ...over, sessionsAbove2B: 20 }, 10, NOW);
    expect(due.eligible).toBe(false);
    expect(due.reasons).toEqual(['above $2B for 20 sessions: reclassify as smid']);
    expect(checkEligibility('X', 'small', { ...good, marketCapUsd: 1_999_999_999 }, 10, NOW).warnings).toEqual([]);
  });

  test('Smid: a name in the $2B to $5B band is eligible and the same name can drift past $5B without being forced out', () => {
    expect(checkEligibility('USAR', 'smid', smidData, 9.6, NOW)).toMatchObject({ eligible: true, warnings: [] });
    const grown = checkEligibility('USAR', 'smid', { ...good, marketCapUsd: 6_500_000_000 }, 9.6, NOW);
    expect(grown.eligible).toBe(true);
    expect(grown.warnings[0]).toContain('$5B listing ceiling');
  });

  test('Smid below $2B is allowed, with a note that it could be Small', () => {
    const r = checkEligibility('X', 'smid', good, 10, NOW);
    expect(r.eligible).toBe(true);
    expect(r.warnings[0]).toContain('reclassified as small');
  });

  test('any tier goes close-only after 20 sessions above $10B, and is warned before that', () => {
    const huge = { ...good, marketCapUsd: 12_000_000_000 };
    expect(checkEligibility('X', 'smid', { ...huge, sessionsAbove10B: 5 }, 10, NOW)).toMatchObject({ eligible: true });
    expect(checkEligibility('X', 'smid', { ...huge, sessionsAbove10B: 5 }, 10, NOW).warnings.join(' ')).toContain('5/20 sessions');
    const stopped = checkEligibility('X', 'smid', { ...huge, sessionsAbove10B: 20 }, 10, NOW);
    expect(stopped.eligible).toBe(false);
    expect(stopped.reasons[0]).toContain('close-only');
    expect(checkEligibility('X', 'small', { ...huge, sessionsAbove10B: 25, sessionsAbove2B: 30 }, 10, NOW).reasons).toHaveLength(2);
  });

  test('every failing rule is reported, not just the first', () => {
    const r = checkEligibility('X', 'micro', { marketCapUsd: 5_000_000_000, avgDailyDollarVolumeUsd: 100, asOf: '2026-11-09' }, 0.5, NOW);
    expect(r.reasons).toHaveLength(3); // micro band, volume, price
    expect(r.eligible).toBe(false);
  });
});

describe('a market that fails the rule can still be exited', () => {
  const o = (source: Observation['source'], price: string): Observation => ({ source, priceE18: parseE18(price), observedAt: NOW, sourceUpdatedAt: NOW - 1_000 });
  const run = (reduceOnly: string | null) => {
    let s = newEngineState();
    let r = stepMark(s, { observations: [o('chainlink', '100'), o('rh_quote', '100.1')], now: NOW, session: Status.Open, halted: false, frozen: false, reduceOnly }, DEFAULT_PRICING_CONFIG, 2_000);
    for (let i = 0; i < 3; i++) {
      s = r.state;
      r = stepMark(s, { observations: [o('chainlink', '100'), o('rh_quote', '100.1')], now: NOW, session: Status.Open, halted: false, frozen: false, reduceOnly }, DEFAULT_PRICING_CONFIG, 2_000);
    }
    return r.decision!;
  };

  test('an eligible market, once warm, publishes a confidence that lets opens through', () => {
    expect(run(null).confidenceBps).toBeLessThan(200);
  });

  test('an ineligible market publishes the real price but a confidence no open can pass', () => {
    const d = run('listing rule: no market data on file');
    expect(d.priceE18).toBe(parseE18('100.05')); // the price is still right, so exits and liquidations work
    expect(d.status).toBe(Status.Open);
    expect(d.confidenceBps).toBe(DEFAULT_PRICING_CONFIG.singleSourceConfidenceBps);
    expect(d.reason).toContain('reduce-only: listing rule: no market data');
  });

  test('the weekend hold is closed to new positions too', () => {
    const r = stepMark(
      { ...newEngineState(), refCloseE18: parseE18('100') },
      { observations: [], now: NOW, session: Status.Weekend, halted: false, frozen: false, reduceOnly: 'listing rule: no market data on file' },
      DEFAULT_PRICING_CONFIG,
      2_000,
    );
    expect(r.decision!.status).toBe(Status.Weekend);
    expect(r.decision!.confidenceBps).toBe(DEFAULT_PRICING_CONFIG.singleSourceConfidenceBps);
  });
});
