/** Mirrors IMarkOracle.Status on-chain. */
export const Status = { Unset: 0, Open: 1, Extended: 2, Weekend: 3, Frozen: 4, Halted: 5 } as const;
export type Status = (typeof Status)[keyof typeof Status];
export const STATUS_NAMES = ['unset', 'open', 'extended', 'weekend', 'frozen', 'halted'] as const;
export type StatusName = (typeof STATUS_NAMES)[number];
export const statusName = (s: Status): StatusName => STATUS_NAMES[s];

/** Mirrors IExchange.MarketState on-chain. Paused = no new entries; reduces always allowed. */
export const MarketState = { Unset: 0, Active: 1, CloseOnly: 2, Paused: 3 } as const;
export type MarketState = (typeof MarketState)[keyof typeof MarketState];

/** micro < $300M cap, small < $2B, smid $2B to $5B at listing (up to 5x leverage once the Counter is large enough), index = baskets. */
export type MarketClass = 'micro' | 'small' | 'smid' | 'index';

export type SourceName = 'chainlink' | 'rh_quote' | 'pyth' | 'uni_v3' | 'uni_v4';

export interface Observation {
  source: SourceName;
  /** Price in token terms (multiplier already applied), E18. */
  priceE18: bigint;
  bidE18?: bigint;
  askE18?: bigint;
  multiplierE18?: bigint;
  /** When we fetched it, ms epoch. */
  observedAt: number;
  /** When the source says the value was produced, ms epoch. */
  sourceUpdatedAt: number;
  halted?: boolean;
}

export interface MarketMeta {
  symbol: string;
  marketId: `0x${string}`;
  stockToken: `0x${string}`;
  chainlinkFeed: `0x${string}`;
  pythFeedId?: string;
  class: MarketClass;
  tags: string[];
}
