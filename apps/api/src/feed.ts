import type { Hex } from 'viem';

/** Order matches `MarkOracle`'s `Status` enum, so the number stored on-chain maps straight to a name. */
export const MARK_STATUS = ['unset', 'open', 'extended', 'weekend', 'frozen', 'halted'] as const;

/** What `MarkOracle.markOf` returns, as viem decodes it. */
export interface RawMark {
  priceE18: bigint;
  confidenceBps: number;
  status: number;
  sequence: bigint;
  updatedAt: bigint;
  breaker: boolean;
}

export interface FeedRow {
  symbol: string;
  class: string;
  marketId: Hex;
  /** Exact on-chain value, 18 decimals, as a string so no precision is lost in JSON. */
  priceE18: string;
  /** The same price in plain USD, six decimals. */
  price: string | null;
  status: (typeof MARK_STATUS)[number];
  confidenceBps: number;
  sequence: string;
  /** Unix seconds when the price was observed (not when it was published). */
  observedAt: number;
  /** Seconds between that observation and the chain's clock. */
  ageSec: number | null;
  /** True when the price is newer than `FRESH_WITHIN_SEC` and the oracle's circuit breaker is not tripped. */
  fresh: boolean;
  breaker: boolean;
}

/** E18 fixed point to a plain decimal string with `dp` places, truncated (never rounded up). */
export function e18ToDecimal(value: bigint, dp = 6): string {
  const scale = 10n ** BigInt(18 - dp);
  const scaled = value / scale;
  const whole = scaled / 10n ** BigInt(dp);
  const frac = (scaled % 10n ** BigInt(dp)).toString().padStart(dp, '0');
  return `${whole}.${frac}`;
}

/** A price older than this is still on-chain, but it is history, not a live quote: marks are only published when someone trades. */
export const FRESH_WITHIN_SEC = 300;

export function feedRow(symbol: string, cls: string, marketId: Hex, mark: RawMark, nowSec: bigint): FeedRow {
  const hasPrice = mark.priceE18 > 0n;
  // A timestamp ahead of the chain clock (a few seconds of tolerated skew) counts as age 0, never negative.
  const observed = mark.updatedAt;
  const ageSec = hasPrice && observed > 0n ? Number(nowSec > observed ? nowSec - observed : 0n) : null;
  return {
    symbol,
    class: cls,
    marketId,
    priceE18: mark.priceE18.toString(),
    price: hasPrice ? e18ToDecimal(mark.priceE18) : null,
    status: MARK_STATUS[mark.status] ?? 'unset',
    confidenceBps: mark.confidenceBps,
    sequence: mark.sequence.toString(),
    observedAt: Number(observed),
    ageSec,
    fresh: ageSec !== null && ageSec <= FRESH_WITHIN_SEC && !mark.breaker,
    breaker: mark.breaker,
  };
}
