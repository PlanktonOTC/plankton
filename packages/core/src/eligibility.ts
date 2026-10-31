import { bpsOf } from './units.ts';
import type { MarketClass } from './types.ts';

/**
 * The listing rule. Every name needs a fresh data row, a price of at least $1 and at least $2M of daily dollar volume.
 * On top of that each size tier has a band, and the bands are enforced with a grace period, as the expansion plan says:
 * - Small: under $2B. Above $2B it stays Small, with a warning, for 20 sessions; after that it must be reclassified.
 * - Smid: $2B to $5B when LISTED (a human checks that when adding it). Once listed it is only stopped by the ceiling below.
 * - Any tier: above $10B for 20 sessions means close-only.
 */
export const LISTING_RULE = {
  /** A "micro" tag needs a cap strictly below this. */
  microMaxMarketCapUsd: 300_000_000,
  /** Small tier: market cap strictly below this. */
  smallMaxMarketCapUsd: 2_000_000_000,
  /** Smid tier: the ceiling at LISTING time. Not enforced afterwards, so a name that grows is not forced out. */
  smidMaxAtListingUsd: 5_000_000_000,
  /** Above this for `sessionsToAct` sessions, a name takes no new positions. */
  closeOnlyAboveUsd: 10_000_000_000,
  /** Sessions above a band before a name must move up a tier, or (above $10B) go close-only. */
  sessionsToAct: 20,
  /** Price floor: nothing under $1 is listed. */
  minPriceUsd: 1,
  /** Average daily dollar volume of the underlying stock. */
  minDailyDollarVolumeUsd: 2_000_000,
  /** The market data on file must be this recent. */
  maxDataAgeDays: 14,
  /** Open interest ceiling per market: 1% of daily dollar volume. */
  absOiCapBpsOfVolume: 100,
} as const;

/** What we know about a stock from outside (kept by hand in config/market-data.json). */
export interface MarketData {
  marketCapUsd: number;
  avgDailyDollarVolumeUsd: number;
  /** YYYY-MM-DD the figures were taken. */
  asOf: string;
  /** Consecutive sessions the market cap has been above $2B. You keep this count; leave it out (0) when it is not above. */
  sessionsAbove2B?: number;
  /** Consecutive sessions the market cap has been above $10B. */
  sessionsAbove10B?: number;
}

export interface Eligibility {
  symbol: string;
  eligible: boolean;
  /** Every rule that failed, in plain words. Empty when eligible. */
  reasons: string[];
  /** Things to act on that do not stop trading yet (a tier change coming up, for example). */
  warnings: string[];
  /** 1% of daily dollar volume, in USDG (6 decimals). 0 when there is no data. */
  absOiCapUsdg: bigint;
}

/**
 * Applies the listing rule. A missing or stale data row is a failure: we never list on a guess.
 * `priceUsd` is the live price (the mark or a Robinhood quote), or null when none is available.
 */
export function checkEligibility(symbol: string, cls: MarketClass, data: MarketData | undefined, priceUsd: number | null, nowMs: number): Eligibility {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let absOiCapUsdg = 0n;
  const R = LISTING_RULE;

  if (!data) {
    reasons.push('no market data on file');
  } else {
    const ageDays = (nowMs - Date.parse(`${data.asOf}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(ageDays)) reasons.push('market data date is not valid');
    else if (ageDays > R.maxDataAgeDays) reasons.push(`market data is ${Math.floor(ageDays)} days old (limit ${R.maxDataAgeDays})`);

    if (!(data.avgDailyDollarVolumeUsd >= R.minDailyDollarVolumeUsd)) reasons.push('average daily dollar volume is under $2M');

    const cap = data.marketCapUsd;
    const above2 = data.sessionsAbove2B ?? 0;
    const above10 = data.sessionsAbove10B ?? 0;

    if (cap >= R.closeOnlyAboveUsd) {
      if (above10 >= R.sessionsToAct) reasons.push(`market cap above $10B for ${above10} sessions: close-only`);
      else warnings.push(`market cap is above $10B (${above10}/${R.sessionsToAct} sessions): close-only after ${R.sessionsToAct}; keep sessionsAbove10B up to date`);
    }

    if (cls === 'micro') {
      if (!(cap < R.microMaxMarketCapUsd)) reasons.push('tagged micro but market cap is not under $300M');
    } else if (cls === 'small') {
      if (cap >= R.smallMaxMarketCapUsd) {
        if (above2 >= R.sessionsToAct) reasons.push(`above $2B for ${above2} sessions: reclassify as smid`);
        else warnings.push(`market cap is above $2B (${above2}/${R.sessionsToAct} sessions): reclassify as smid after ${R.sessionsToAct}`);
      }
    } else if (cls === 'smid') {
      if (cap < R.smallMaxMarketCapUsd) warnings.push('market cap is under $2B: can be reclassified as small');
      else if (cap >= R.smidMaxAtListingUsd && cap < R.closeOnlyAboveUsd) warnings.push('market cap is above the $5B listing ceiling (fine for a name already listed)');
    }

    if (data.avgDailyDollarVolumeUsd > 0) {
      absOiCapUsdg = bpsOf(BigInt(Math.floor(data.avgDailyDollarVolumeUsd)) * 1_000_000n, R.absOiCapBpsOfVolume);
    }
  }

  if (priceUsd !== null && priceUsd < R.minPriceUsd) reasons.push('price is under $1');

  return { symbol, eligible: reasons.length === 0, reasons, warnings, absOiCapUsdg };
}
