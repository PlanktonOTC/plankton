import { BPS, E18, abs, diffBps } from './units.ts';
import type { Observation, SourceName } from './types.ts';

export type PrimarySource = Extract<SourceName, 'chainlink' | 'rh_quote' | 'pyth'>;

export interface PricingConfig {
  maxAgeMs: Record<PrimarySource, number>;
  /** Max spread between primaries for them to count as agreeing. */
  agreeBps: number;
  /** Confidence reported when only one primary is fresh. Above every maxConfidenceBps, so opens revert on-chain. */
  singleSourceConfidenceBps: number;
  /** Consecutive agreeing samples required before opens are allowed after start-up or a gap. */
  warmupSamples: number;
  /** Confidence reported while the book is held (weekend). */
  heldConfidenceBps: number;
  /**
   * Fresh primaries needed before opens. 2 everywhere Chainlink covers the market. 1 for a market it does not cover,
   * which is then priced from Robinhood's quote alone, with the single-source guards below.
   */
  minSources: number;
  /** Single-source guard: opens stop while the mark is further than this from its own 15-minute average. 0 = off. */
  maxAvgDeviationBps: number;
}

/**
 * Chainlink equity feeds are deviation-triggered (about 0.5% on AAPL) with a long heartbeat: measured gaps between
 * updates on 2026-10-27..30 ran from 2 minutes to about 20 hours. A feed that has not moved is still correct, so its
 * age limit only has to catch a dead feed (heartbeat plus margin). The safety check is agreement with the other
 * source. Both numbers are overridable per market in config/markets.json.
 */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  maxAgeMs: { chainlink: 25 * 3_600_000, rh_quote: 60_000, pyth: 30_000 },
  agreeBps: 150,
  singleSourceConfidenceBps: 9_999,
  warmupSamples: 3,
  heldConfidenceBps: 25,
  minSources: 2,
  maxAvgDeviationBps: 0,
};

/**
 * A market Chainlink does not cover, priced from Robinhood's quote alone. Every on-chain mark is quorum-signed, and opens
 * also wait for 20 live marks after a start or gap and stop while the mark is over 3% from its 15-minute average.
 */
export const SINGLE_SOURCE_PRICING: Pick<PricingConfig, 'minSources' | 'warmupSamples' | 'maxAvgDeviationBps'> = {
  minSources: 1,
  warmupSamples: 20,
  maxAvgDeviationBps: 300,
};

/** Single-source guard: a Robinhood bid/ask that has not changed for this long counts as stale. */
export const MAX_UNCHANGED_QUOTE_MS = 10 * 60_000;

/** Robinhood quotes are underlying share prices: token price = underlying * multiplier. */
export const tokenPriceFromUnderlying = (underlyingE18: bigint, multiplierE18: bigint): bigint =>
  (underlyingE18 * multiplierE18) / E18;

/** Chainlink equity feeds are already in token terms. Never multiply them again. */
export function rhMid(bidE18: bigint, askE18: bigint, multiplierE18: bigint): bigint {
  return tokenPriceFromUnderlying((bidE18 + askE18) / 2n, multiplierE18);
}

export function median(values: bigint[]): bigint {
  if (values.length === 0) throw new RangeError('median of empty set');
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/** (max - min) / median in bps. */
export function dispersionBps(values: bigint[]): bigint {
  if (values.length < 2) return 0n;
  const med = median(values);
  let lo = values[0]!;
  let hi = values[0]!;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return med === 0n ? BPS * 100n : ((hi - lo) * BPS) / med;
}

/** Half the bid/ask spread as bps of mid. */
export function halfSpreadBps(o: Observation): bigint {
  if (o.bidE18 === undefined || o.askE18 === undefined) return 0n;
  const mid = (o.bidE18 + o.askE18) / 2n;
  return mid === 0n ? 0n : ((o.askE18 - o.bidE18) * BPS) / (2n * mid);
}

/** Confidence is an uncertainty width in bps (lower is better): the larger of source dispersion and half-spread. */
export function confidenceBps(fresh: Observation[]): number {
  const disp = dispersionBps(fresh.map((o) => o.priceE18));
  let spread = 0n;
  for (const o of fresh) {
    const h = halfSpreadBps(o);
    if (h > spread) spread = h;
  }
  const c = disp > spread ? disp : spread;
  return Number(c > 9_999n ? 9_999n : c);
}

export function isFresh(o: Observation, now: number, cfg: PricingConfig): boolean {
  if (o.halted) return false;
  if (o.source !== 'chainlink' && o.source !== 'rh_quote' && o.source !== 'pyth') return false;
  const age = now - o.sourceUpdatedAt;
  return age >= 0 && age <= cfg.maxAgeMs[o.source] && o.priceE18 > 0n;
}

/** Latest observation per source. */
export function latestBySource(obs: Observation[]): Map<SourceName, Observation> {
  const m = new Map<SourceName, Observation>();
  for (const o of obs) {
    const prev = m.get(o.source);
    if (!prev || o.observedAt >= prev.observedAt) m.set(o.source, o);
  }
  return m;
}

export interface Aggregate {
  /** Fresh primaries used. */
  used: Observation[];
  priceE18: bigint | null;
  dispersionBps: number;
  confidenceBps: number;
  agree: boolean;
}

export function aggregate(obs: Observation[], now: number, cfg: PricingConfig): Aggregate {
  const used = [...latestBySource(obs).values()].filter((o) => isFresh(o, now, cfg));
  if (used.length === 0) return { used, priceE18: null, dispersionBps: 0, confidenceBps: 9_999, agree: false };
  const prices = used.map((o) => o.priceE18);
  const disp = Number(dispersionBps(prices));
  const enough = used.length >= cfg.minSources;
  const agree = enough && (used.length < 2 || disp <= cfg.agreeBps);
  return {
    used,
    priceE18: median(prices),
    dispersionBps: disp,
    confidenceBps: enough ? confidenceBps(used) : cfg.singleSourceConfidenceBps,
    agree,
  };
}

/** True when two token prices are continuous across a multiplier change (e.g. a 2:1 split). */
export function multiplierContinuous(priceBeforeE18: bigint, priceAfterE18: bigint, tolBps = 300): boolean {
  return diffBps(priceAfterE18, priceBeforeE18) <= BigInt(tolBps);
}

/** |a - b| in bps, for the jump breaker pre-check. */
export const jumpBps = (priceE18: bigint, priorE18: bigint): bigint => (priorE18 === 0n ? 0n : (abs(priceE18 - priorE18) * BPS) / priorE18);
