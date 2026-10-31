import { aggregate, jumpBps, type PricingConfig } from './pricing.ts';
import { Status, type Observation } from './types.ts';

export interface EngineState {
  lastGoodE18: bigint | null;
  lastGoodAt: number | null;
  /** Last mark taken during a regular session (becomes Friday's close over the weekend). */
  refCloseE18: bigint | null;
  agreeStreak: number;
  lastPublishedE18: bigint | null;
  lastPublishedAt: number | null;
}

export const newEngineState = (): EngineState => ({
  lastGoodE18: null,
  lastGoodAt: null,
  refCloseE18: null,
  agreeStreak: 0,
  lastPublishedE18: null,
  lastPublishedAt: null,
});

export interface EngineInput {
  observations: Observation[];
  now: number;
  /** Session status from the calendar (Open/Extended/Weekend/Frozen). */
  session: Status;
  /** Nasdaq Trader halt or Robinhood isTradingHalt. */
  halted: boolean;
  /** Corporate action pending, pendingMultiplier seen, or oraclePaused(). */
  frozen: boolean;
  /**
   * Cold start over a closed session: the newest Chainlink answer (a few days old at most), used only to open the
   * weekend hold when we have never seen a regular-session mark.
   */
  seedPriceE18?: bigint | null;
  /**
   * Why this market may not take new positions (for example, it fails the listing rule). The mark is still published,
   * but with a confidence no open can pass, so the contract itself refuses opens while exits keep working.
   */
  reduceOnly?: string | null;
}

export interface MarkDecision {
  status: Status;
  priceE18: bigint;
  refCloseE18: bigint;
  confidenceBps: number;
  dispersionBps: number;
  sources: string[];
  reason: string;
  /** Mark moved by more than jumpBps vs the last published value (the contract will set its breaker). */
  jump: boolean;
}

export interface StepResult {
  state: EngineState;
  /** null when there is nothing safe to publish (no price has ever been observed). */
  decision: MarkDecision | null;
}

/**
 * One tick of the mark engine. Rules from the spec:
 * - two fresh primaries that agree are needed for opens; one source only reduces risk (confidence is set above every cap);
 * - halts publish Halted, pending corporate actions and stale feeds publish Frozen, both at the last good price;
 * - over the weekend the mark is held at the last regular-session mark;
 * - warm-up: opens stay blocked until `warmupSamples` consecutive agreeing ticks.
 */
export function stepMark(prev: EngineState, input: EngineInput, cfg: PricingConfig, jumpLimitBps: number): StepResult {
  const state: EngineState = { ...prev };
  const held = state.lastGoodE18;

  const make = (
    status: Status,
    priceE18: bigint,
    confidence: number,
    disp: number,
    sources: string[],
    reason: string,
  ): StepResult => {
    if (input.reduceOnly) {
      confidence = Math.max(confidence, cfg.singleSourceConfidenceBps);
      reason = `${reason}; reduce-only: ${input.reduceOnly}`;
    }
    const jump = state.lastPublishedE18 !== null && jumpBps(priceE18, state.lastPublishedE18) > BigInt(jumpLimitBps);
    state.lastPublishedE18 = priceE18;
    state.lastPublishedAt = input.now;
    const ref = state.refCloseE18 ?? priceE18;
    return { state, decision: { status, priceE18, refCloseE18: ref, confidenceBps: confidence, dispersionBps: disp, sources, reason, jump } };
  };

  if (input.halted) {
    state.agreeStreak = 0;
    if (held === null) return { state, decision: null };
    return make(Status.Halted, held, 9_999, 0, [], 'trading halt');
  }

  if (input.session === Status.Weekend) {
    state.agreeStreak = 0;
    const px = state.refCloseE18 ?? held ?? input.seedPriceE18 ?? null;
    if (px === null) return { state, decision: null };
    return make(Status.Weekend, px, cfg.heldConfidenceBps, 0, [], 'weekend hold at last regular mark');
  }

  if (input.frozen || input.session === Status.Frozen || input.session === Status.Unset) {
    state.agreeStreak = 0;
    if (held === null) return { state, decision: null };
    return make(Status.Frozen, held, 9_999, 0, [], input.frozen ? 'corporate action or oracle paused' : 'session unavailable');
  }

  const agg = aggregate(input.observations, input.now, cfg);
  if (agg.priceE18 === null) {
    state.agreeStreak = 0;
    if (held === null) return { state, decision: null };
    return make(Status.Frozen, held, 9_999, 0, [], 'no fresh primary source');
  }

  if (agg.agree) state.agreeStreak += 1;
  else state.agreeStreak = 0;

  let confidence = agg.confidenceBps;
  let reason = 'two sources agree';
  if (agg.used.length < 2) {
    reason = 'single source: reduce-only';
  } else if (!agg.agree) {
    confidence = Math.max(confidence, cfg.singleSourceConfidenceBps);
    reason = 'sources disagree: reduce-only';
  } else if (state.agreeStreak < cfg.warmupSamples) {
    confidence = Math.max(confidence, cfg.singleSourceConfidenceBps);
    reason = `warming up ${state.agreeStreak}/${cfg.warmupSamples}`;
  }

  // Only a two-source agreement may become the new "last good" price.
  if (agg.agree) {
    state.lastGoodE18 = agg.priceE18;
    state.lastGoodAt = input.now;
    if (input.session === Status.Open) state.refCloseE18 = agg.priceE18;
  }

  return make(input.session, agg.priceE18, confidence, agg.dispersionBps, agg.used.map((o) => o.source), reason);
}

/** Publish on change above `republishBps`, on a heartbeat, or when the status flips. */
export function shouldPublish(
  prev: { priceE18: bigint; at: number; status: Status } | null,
  next: { priceE18: bigint; status: Status },
  nowMs: number,
  opts: { republishBps: number; heartbeatMs: number },
): boolean {
  if (!prev) return true;
  if (prev.status !== next.status) return true;
  if (nowMs - prev.at >= opts.heartbeatMs) return true;
  return jumpBps(next.priceE18, prev.priceE18) >= BigInt(opts.republishBps);
}
