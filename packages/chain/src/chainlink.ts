import { parseAbi, type Address } from 'viem';
import type { Observation } from '@plankton/core';
import type { ChainClient } from './client.ts';

export const AGGREGATOR_V3_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export interface FeedRef {
  symbol: string;
  feed: Address;
}

const decimalsCache = new Map<string, number>();

/**
 * Read the latest answer of every feed in one multicall.
 * Chainlink equity feeds are already in Stock Token terms (multiplier embedded): never multiply them again.
 * A failed or non-positive answer yields null for that symbol.
 */
export async function readChainlink(client: ChainClient, feeds: FeedRef[], now = Date.now()): Promise<Map<string, Observation | null>> {
  const out = new Map<string, Observation | null>();
  if (feeds.length === 0) return out;

  const missing = feeds.filter((f) => !decimalsCache.has(f.feed.toLowerCase()));
  if (missing.length > 0) {
    const res = await client.multicall({
      contracts: missing.map((f) => ({ address: f.feed, abi: AGGREGATOR_V3_ABI, functionName: 'decimals' as const })),
      allowFailure: true,
    });
    missing.forEach((f, i) => {
      const r = res[i]!;
      if (r.status === 'success') decimalsCache.set(f.feed.toLowerCase(), Number(r.result));
    });
  }

  const rounds = await client.multicall({
    contracts: feeds.map((f) => ({ address: f.feed, abi: AGGREGATOR_V3_ABI, functionName: 'latestRoundData' as const })),
    allowFailure: true,
  });

  feeds.forEach((f, i) => {
    const dec = decimalsCache.get(f.feed.toLowerCase());
    const r = rounds[i]!;
    if (dec === undefined || r.status !== 'success') return void out.set(f.symbol, null);
    const [, answer, , updatedAt] = r.result;
    if (answer <= 0n) return void out.set(f.symbol, null);
    const priceE18 = dec <= 18 ? answer * 10n ** BigInt(18 - dec) : answer / 10n ** BigInt(dec - 18);
    out.set(f.symbol, {
      source: 'chainlink',
      priceE18,
      observedAt: now,
      sourceUpdatedAt: Number(updatedAt) * 1000,
    });
  });
  return out;
}
