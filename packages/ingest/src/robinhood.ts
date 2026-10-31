import { z } from 'zod';
import { diffBps, parseE18, rhMid, type Observation } from '@plankton/core';

// Schemas follow the live responses observed on 2026-10-30. Unknown fields are passed through.
const deployment = z.looseObject({ contractAddress: z.string(), chainId: z.number() });

const quote = z.looseObject({
  tokenSymbol: z.string(),
  deployments: z.array(deployment),
  bid: z.string(),
  ask: z.string(),
  dailyTradingVolume: z.string().optional(),
  isTradingHalt: z.boolean().optional(),
  generatedAt: z.string(),
  tokenBid: z.string().optional(),
  tokenAsk: z.string().optional(),
});
const pricesResponse = z.object({ quotes: z.array(quote) });

const asset = z.looseObject({
  tokenSymbol: z.string(),
  deployments: z.array(deployment),
  currentMultiplier: z.string(),
  pendingMultiplier: z.string().optional().default(''),
  status: z.string(),
});
const assetsResponse = z.object({ assets: z.array(asset) });

const corpAction = z.looseObject({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  tokenSymbol: z.string(),
  processDate: z.object({ year: z.number(), month: z.number(), day: z.number() }).optional(),
});
const corpActionsResponse = z.object({ corpActions: z.array(corpAction) });

export type RhQuote = z.infer<typeof quote>;
export type RhAsset = z.infer<typeof asset>;
export type RhCorpAction = z.infer<typeof corpAction>;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

export const fetchRhPrices = async (base: string): Promise<RhQuote[]> => pricesResponse.parse(await getJson(`${base}/prices`)).quotes;
export const fetchRhAssets = async (base: string): Promise<RhAsset[]> => assetsResponse.parse(await getJson(`${base}/assets`)).assets;
export const fetchRhCorpActions = async (base: string): Promise<RhCorpAction[]> =>
  corpActionsResponse.parse(await getJson(`${base}/corporate-actions`)).corpActions;

/** Robinhood returns timestamps with nanoseconds; JS parses at most milliseconds reliably. */
const parseTs = (s: string): number => Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));

export type RhIssue = 'asset_missing' | 'asset_inactive' | 'wrong_contract' | 'pending_multiplier' | 'bad_quote' | 'multiplier_mismatch';

export interface RhReading {
  observation: Observation | null;
  halted: boolean;
  /** Reasons the market must not be priced from this source. */
  issues: RhIssue[];
  dailyTradingVolume?: string;
}

/**
 * Build the Robinhood leg of the mark for one market.
 * token price = underlying mid * currentMultiplier. The documented tokenBid/tokenAsk are used only as a cross-check;
 * a disagreement above 5 bps means we mis-read the multiplier, so the source is dropped instead of trusted.
 */
export function rhReading(symbol: string, stockToken: string, chainId: number, quotes: RhQuote[], assets: RhAsset[]): RhReading {
  const issues: RhIssue[] = [];
  const a = assets.find((x) => x.tokenSymbol === symbol);
  const q = quotes.find((x) => x.tokenSymbol === symbol);
  if (!a) issues.push('asset_missing');
  else {
    if (a.status !== 'ASSET_STATUS_ACTIVE') issues.push('asset_inactive');
    const dep = a.deployments.find((d) => d.chainId === chainId);
    if (!dep || dep.contractAddress.toLowerCase() !== stockToken.toLowerCase()) issues.push('wrong_contract');
    if (a.pendingMultiplier !== '' && a.pendingMultiplier !== a.currentMultiplier) issues.push('pending_multiplier');
  }
  const halted = q?.isTradingHalt === true;
  if (!a || !q || issues.some((i) => i !== 'pending_multiplier')) return { observation: null, halted, issues };

  try {
    const bid = parseE18(q.bid);
    const ask = parseE18(q.ask);
    const mult = parseE18(a.currentMultiplier);
    if (bid <= 0n || ask < bid || mult <= 0n) return { observation: null, halted, issues: [...issues, 'bad_quote'] };
    const mid = rhMid(bid, ask, mult);
    if (q.tokenBid && q.tokenAsk) {
      const robinhoodMid = (parseE18(q.tokenBid) + parseE18(q.tokenAsk)) / 2n;
      if (diffBps(mid, robinhoodMid) > 5n) return { observation: null, halted, issues: [...issues, 'multiplier_mismatch'] };
    }
    const tokenBid = (bid * mult) / 10n ** 18n;
    const tokenAsk = (ask * mult) / 10n ** 18n;
    return {
      observation: {
        source: 'rh_quote',
        priceE18: mid,
        bidE18: tokenBid,
        askE18: tokenAsk,
        multiplierE18: mult,
        observedAt: Date.now(),
        sourceUpdatedAt: parseTs(q.generatedAt),
        halted,
      },
      halted,
      issues,
      dailyTradingVolume: q.dailyTradingVolume,
    };
  } catch {
    return { observation: null, halted, issues: [...issues, 'bad_quote'] };
  }
}

/**
 * Any corporate action other than a cash dividend (splits, mergers, symbol changes) that is not completed and is
 * processed within +/-36h freezes the market. Dividends move the multiplier and are caught by pending_multiplier.
 */
export function corporateActionFreeze(actions: RhCorpAction[], symbol: string, nowMs: number): boolean {
  return actions.some((a) => {
    if (a.tokenSymbol !== symbol || a.type === 'CORPORATE_ACTION_TYPE_CASH_DIVIDEND') return false;
    if (a.status === 'CORPORATE_ACTION_STATUS_COMPLETED') return false;
    if (!a.processDate) return true;
    const at = Date.UTC(a.processDate.year, a.processDate.month - 1, a.processDate.day);
    return Math.abs(at - nowMs) <= 36 * 3_600_000;
  });
}
