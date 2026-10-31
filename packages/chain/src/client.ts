import { createPublicClient, createWalletClient, fallback, http, nonceManager } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodChain } from './chain.ts';

/**
 * Read client over an ordered list of RPC URLs (paid provider first, public RPC last).
 * Calls to multicall3 are batched automatically.
 */
export function createChainClient(rpcUrls: string[]) {
  const transports = rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 }));
  return createPublicClient({
    chain: robinhoodChain,
    transport: transports.length === 1 ? transports[0]! : fallback(transports, { rank: false, retryCount: 1 }),
    batch: { multicall: true },
  });
}

export type ChainClient = ReturnType<typeof createChainClient>;

type ChainWallet = ReturnType<typeof createChainWallet>;
type WriteRequest = Parameters<ChainWallet['wallet']['writeContract']>[0];

/**
 * Sends a contract call with 25% extra gas. The Exchange reaches its libraries and other contracts through nested calls,
 * and a node's estimate can land a little short once the 63/64 gas-forwarding rule applies: the call then runs out of
 * gas mid-way and reverts. Every service that sends transactions should go through this.
 */
export async function writeWithGasMargin(client: ChainClient, w: ChainWallet, request: WriteRequest): Promise<`0x${string}`> {
  const estimate = await client.estimateContractGas({ ...(request as object), account: w.account } as never);
  return w.wallet.writeContract({ ...request, gas: (estimate * 125n) / 100n } as WriteRequest);
}

const timeCache = new WeakMap<object, { at: number; ts: bigint }>();

/**
 * "Now" according to the chain, in seconds. The contracts compare expiries and ages against block.timestamp, so
 * anything that signs or checks a deadline must use this and not the server's own clock.
 * Cached for a second, with the local seconds since added on.
 */
export async function chainTimeSec(client: ChainClient): Promise<bigint> {
  const hit = timeCache.get(client);
  const now = Date.now();
  if (hit && now - hit.at < 1_000) return hit.ts + BigInt(Math.floor((now - hit.at) / 1_000));
  const block = await client.getBlock({ blockTag: 'latest' });
  timeCache.set(client, { at: now, ts: block.timestamp });
  return block.timestamp;
}

/** Write client for a service wallet (publisher, keeper). Uses viem's local nonce manager so back-to-back sends do not collide. */
export function createChainWallet(rpcUrls: string[], privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey, { nonceManager });
  const transports = rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 }));
  const wallet = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: transports.length === 1 ? transports[0]! : fallback(transports, { rank: false, retryCount: 1 }),
  });
  return { account, wallet };
}
