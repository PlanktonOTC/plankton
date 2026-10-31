import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PRICING_CONFIG,
  Status,
  newEngineState,
  parseE18,
  shouldPublish,
  stepMark,
  type EngineState,
  type Observation,
} from '../src/index.ts';

const NOW = 1_800_000_000_000;
const JUMP = 2_000;
const cfg = DEFAULT_PRICING_CONFIG;
const o = (source: Observation['source'], price: string, ageMs = 1_000): Observation => ({
  source,
  priceE18: parseE18(price),
  observedAt: NOW,
  sourceUpdatedAt: NOW - ageMs,
});
const both = (a = '100', b = '100.1') => [o('chainlink', a), o('rh_quote', b)];
const input = (over: Partial<Parameters<typeof stepMark>[1]> = {}) => ({
  observations: both(),
  now: NOW,
  session: Status.Open as Status,
  halted: false,
  frozen: false,
  ...over,
});

/** Run the engine through several identical ticks so warm-up completes. */
function warm(state: EngineState, over: Partial<Parameters<typeof stepMark>[1]> = {}, ticks = 3) {
  let s = state;
  let last = stepMark(s, input(over), cfg, JUMP);
  for (let i = 1; i < ticks; i++) {
    s = last.state;
    last = stepMark(s, input(over), cfg, JUMP);
  }
  return last;
}

describe('mark engine', () => {
  test('two agreeing sources warm up for three ticks before opens are allowed', () => {
    let r = stepMark(newEngineState(), input(), cfg, JUMP);
    expect(r.decision?.reason).toContain('warming up 1/3');
    expect(r.decision!.confidenceBps).toBe(cfg.singleSourceConfidenceBps); // too high for opens: they revert on-chain

    r = stepMark(r.state, input(), cfg, JUMP);
    expect(r.decision?.reason).toContain('warming up 2/3');

    r = stepMark(r.state, input(), cfg, JUMP);
    expect(r.decision?.reason).toBe('two sources agree');
    expect(r.decision!.confidenceBps).toBeLessThan(200);
    expect(r.decision!.status).toBe(Status.Open);
    expect(r.decision!.priceE18).toBe(parseE18('100.05'));
    expect(r.decision!.sources.sort()).toEqual(['chainlink', 'rh_quote']);
  });

  test('a single source is reduce-only and never becomes the last good price', () => {
    const r = stepMark(newEngineState(), input({ observations: [o('rh_quote', '100')] }), cfg, JUMP);
    expect(r.decision!.reason).toBe('single source: reduce-only');
    expect(r.decision!.confidenceBps).toBe(cfg.singleSourceConfidenceBps);
    expect(r.state.lastGoodE18).toBeNull();
  });

  test('sources that disagree block opens', () => {
    const r = warm(newEngineState(), { observations: both('100', '104') });
    expect(r.decision!.reason).toBe('sources disagree: reduce-only');
    expect(r.decision!.confidenceBps).toBeGreaterThanOrEqual(cfg.singleSourceConfidenceBps);
  });

  test('disagreement resets the warm-up', () => {
    const good = warm(newEngineState());
    expect(good.decision!.reason).toBe('two sources agree');
    const bad = stepMark(good.state, input({ observations: both('100', '104') }), cfg, JUMP);
    const again = stepMark(bad.state, input(), cfg, JUMP);
    expect(again.decision!.reason).toContain('warming up 1/3');
  });

  test('a trading halt publishes Halted at the last good price', () => {
    const good = warm(newEngineState());
    const r = stepMark(good.state, input({ halted: true }), cfg, JUMP);
    expect(r.decision!.status).toBe(Status.Halted);
    expect(r.decision!.priceE18).toBe(parseE18('100.05'));
    expect(r.decision!.confidenceBps).toBe(9_999);
  });

  test('a halt with no price ever seen publishes nothing', () => {
    expect(stepMark(newEngineState(), input({ halted: true }), cfg, JUMP).decision).toBeNull();
  });

  test('a pending corporate action or paused oracle freezes the market', () => {
    const good = warm(newEngineState());
    const r = stepMark(good.state, input({ frozen: true }), cfg, JUMP);
    expect(r.decision!.status).toBe(Status.Frozen);
    expect(r.decision!.reason).toContain('corporate action');
  });

  test('losing every fresh source freezes at the last good price', () => {
    const good = warm(newEngineState());
    const r = stepMark(good.state, input({ observations: [] }), cfg, JUMP);
    expect(r.decision!.status).toBe(Status.Frozen);
    expect(r.decision!.priceE18).toBe(parseE18('100.05'));
  });

  test('an unavailable session (missing calendar) is Frozen, not guessed', () => {
    const good = warm(newEngineState());
    expect(stepMark(good.state, input({ session: Status.Frozen }), cfg, JUMP).decision!.status).toBe(Status.Frozen);
  });

  test('the weekend holds the last regular-session mark', () => {
    const good = warm(newEngineState(), { session: Status.Open });
    expect(good.state.refCloseE18).toBe(parseE18('100.05'));
    // On Saturday the feeds drift and one goes stale; the held price must not move.
    const r = stepMark(good.state, input({ session: Status.Weekend, observations: [o('rh_quote', '90')] }), cfg, JUMP);
    expect(r.decision!.status).toBe(Status.Weekend);
    expect(r.decision!.priceE18).toBe(parseE18('100.05'));
    expect(r.decision!.confidenceBps).toBe(cfg.heldConfidenceBps);
  });

  test('extended hours do not overwrite the held regular-session close', () => {
    const open = warm(newEngineState(), { session: Status.Open });
    const ext = warm(open.state, { session: Status.Extended, observations: both('105', '105.1') });
    expect(ext.state.refCloseE18).toBe(parseE18('100.05'));
    expect(ext.decision!.status).toBe(Status.Extended);
  });

  test('a cold start on a weekend can use a seeded price, and with none it stays silent', () => {
    expect(stepMark(newEngineState(), input({ session: Status.Weekend }), cfg, JUMP).decision).toBeNull();
    const seeded = stepMark(newEngineState(), input({ session: Status.Weekend, seedPriceE18: parseE18('344.9') }), cfg, JUMP);
    expect(seeded.decision!.priceE18).toBe(parseE18('344.9'));
    expect(seeded.decision!.status).toBe(Status.Weekend);
  });

  test('a move beyond the jump limit is flagged', () => {
    const good = warm(newEngineState());
    const r = stepMark(good.state, input({ observations: both('130', '130.1') }), cfg, JUMP);
    expect(r.decision!.jump).toBe(true);
    const small = stepMark(good.state, input({ observations: both('101', '101.1') }), cfg, JUMP);
    expect(small.decision!.jump).toBe(false);
  });
});

describe('when to publish', () => {
  const opts = { republishBps: 10, heartbeatMs: 60_000 };
  const prev = { priceE18: parseE18('100'), at: NOW, status: Status.Open as Status };

  test('always the first time', () => {
    expect(shouldPublish(null, { priceE18: parseE18('100'), status: Status.Open }, NOW, opts)).toBe(true);
  });
  test('not for a tiny move inside the heartbeat', () => {
    expect(shouldPublish(prev, { priceE18: parseE18('100.05'), status: Status.Open }, NOW + 5_000, opts)).toBe(false);
  });
  test('for a move of 10 bps or more', () => {
    expect(shouldPublish(prev, { priceE18: parseE18('100.1'), status: Status.Open }, NOW + 5_000, opts)).toBe(true);
  });
  test('for any status change', () => {
    expect(shouldPublish(prev, { priceE18: parseE18('100'), status: Status.Frozen }, NOW + 1_000, opts)).toBe(true);
  });
  test('on the heartbeat even when nothing moved', () => {
    expect(shouldPublish(prev, { priceE18: parseE18('100'), status: Status.Open }, NOW + 60_000, opts)).toBe(true);
  });
});
