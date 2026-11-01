import type { ChainClient } from './client.ts';

/**
 * The first block at or after a Unix time, by binary search on block timestamps. Works on any node (no archive state)
 * and does not care which block-number convention the chain uses: on Arbitrum-style chains a contract's block.number is
 * the Ethereum block number, which is why the deploy records a time and not a block.
 */
export async function blockAtOrAfter(client: ChainClient, unixSec: number, head?: bigint): Promise<bigint> {
  let lo = 0n;
  let hi = head ?? (await client.getBlockNumber());
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await client.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) < unixSec) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/**
 * Runs `read(from, to)` over a block range and, when the node rejects the range as too large, halves it and retries.
 * A range of one block that still fails is a real error and is thrown.
 */
export async function readRangeSplitting<T>(from: bigint, to: bigint, read: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
  try {
    return await read(from, to);
  } catch (err) {
    if (to <= from) throw err;
    const mid = from + (to - from) / 2n;
    return [...(await readRangeSplitting(from, mid, read)), ...(await readRangeSplitting(mid + 1n, to, read))];
  }
}
