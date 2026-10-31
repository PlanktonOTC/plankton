// Exercises what needs the database and the keeper, on the local fork (see docs/local-fork.md):
//   1. A stop-loss order is signed, submitted to the API, and fired by the keeper with no help from us.
//   2. An order can be cancelled with a signed message; bad signatures and duplicate nonces are refused.
//   3. A position that falls below maintenance margin is liquidated by the keeper.
// Run after `scripts/e2e-fork.ts` (that gives the Counter its money). Needs fork-setup + fork-stack with DATABASE_URL set.
import { erc20Abi, type Hex } from 'viem';
import { loadDeployment, loadMarkets } from '@plankton/config';
import {
  chainTimeSec,
  createChainClient,
  createChainWallet,
  exchangeAbi,
  exchangeDomain,
  marketIdFor,
  oracleAbi,
  orderTypes,
  quoteWire,
  signature as sigSchema,
  toJson,
  vaultAbi,
  writeWithGasMargin,
} from '@plankton/chain';
import { formatE18, formatUsdg } from '@plankton/core';
import { z } from 'zod';

const RPC = 'http://127.0.0.1:8545';
const API = 'http://127.0.0.1:8787';
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const; // anvil 0 (owns the contracts)
const TRADER_KEY = '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e' as const; // anvil 6
const KEEPER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' as const; // anvil 5

const dep = loadDeployment();
const client = createChainClient([RPC]);
const owner = createChainWallet([RPC], OWNER_KEY);
const trader = createChainWallet([RPC], TRADER_KEY);
const first = loadMarkets().markets[0];
if (!first) throw new Error('config/markets.json has no markets');
const SYMBOL = first.symbol;
const market = marketIdFor(SYMBOL, first.stockToken as `0x${string}`);

const step = (m: string) => console.log(`\n${m}`);
const ok = (m: string) => console.log(`  ok   ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = async (w: typeof trader, req: Parameters<typeof trader.wallet.writeContract>[0]) => {
  const hash = await writeWithGasMargin(client, w, req);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  return hash;
};
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : toJson(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | false>, timeoutMs = 90_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const account = async () => (await api('GET', `/v1/accounts/${trader.account.address}`)).json;
const position = () => client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'positionOf', args: [trader.account.address, market] });

/** A position sized to ~70% of whatever the current session allows, at ~90% of the leverage limit. */
async function sizing() {
  const [mark, cfg, nav] = await Promise.all([
    client.readContract({ address: dep.oracle, abi: oracleAbi, functionName: 'markOf', args: [market] }),
    client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'configOf', args: [market] }),
    client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'navUsdg' }),
  ]);
  if (nav < 1_000_000_000n) throw new Error('the Counter is empty: run scripts/e2e-fork.ts first');
  const prof = cfg.profiles[mark.status]!;
  const capUsd = (Number(nav) / 1e6) * (Math.min(Number(prof.maxPositionBpsOfV), cfg.positionBpsOfV) / 10_000);
  const notional = capUsd * 0.6;
  const price = Number(mark.priceE18) / 1e18;
  const lev = (Number(prof.maxLeverageE18) / 1e18) * 0.85;
  return { mark, cfg, sizeE18: BigInt(Math.floor((notional / price) * 1e6)) * 10n ** 12n, marginUsdg: BigInt(Math.ceil((notional / lev) * 1e6)) };
}

const quoteResponse = z.object({ quote: quoteWire, signature: sigSchema });
async function openLong() {
  const s = await sizing();
  const r = await api('POST', '/v1/quote/trade', { market: SYMBOL, trader: trader.account.address, sizeDeltaE18: s.sizeE18, marginUsdg: s.marginUsdg });
  if (r.status !== 200) throw new Error(`quote refused: ${JSON.stringify(r.json)}`);
  const q = quoteResponse.parse(r.json);
  await send(trader, { address: dep.usdg, abi: erc20Abi, functionName: 'approve', args: [dep.exchange, 2n ** 255n] });
  await send(trader, { address: dep.exchange, abi: exchangeAbi, functionName: 'deposit', args: [s.marginUsdg + q.quote.feeUsdg] });
  await send(trader, { address: dep.exchange, abi: exchangeAbi, functionName: 'execute', args: [q.quote, q.signature, s.marginUsdg] });
  const p = await position();
  ok(`long open: ${formatE18(p.size, 4)} ${SYMBOL}, margin ${formatUsdg(BigInt(p.margin))} USDG`);
  return s;
}

async function signedOrder(nonce: bigint, trigger: bigint, above: boolean) {
  const now = await chainTimeSec(client);
  const order = {
    marketId: market,
    trader: trader.account.address,
    kind: 3, // stop-loss
    sizeDeltaE18: 0n,
    sizeBps: 10_000, // the whole position
    triggerE18: trigger,
    triggerAbove: above,
    reduceOnly: true,
    maxSlippageBps: 300,
    marginUsdg: 0n,
    validAfter: now - 30n,
    expiry: now + 3_600n,
    nonce,
  } as const;
  const signature = await trader.account.signTypedData({ domain: exchangeDomain(dep.exchange), types: orderTypes, primaryType: 'Order', message: order });
  return { order, signature };
}
const postOrder = (o: Awaited<ReturnType<typeof signedOrder>>) => api('POST', '/v1/orders', { ...JSON.parse(toJson(o.order)), signature: o.signature });

async function main() {
  // Start from flat: an earlier, interrupted run may have left a position open (the chain keeps it even if the database is wiped).
  if ((await position()).size !== 0n) {
    await send(trader, { address: dep.exchange, abi: exchangeAbi, functionName: 'closeAtMark', args: [market, 10_000] });
    console.log('(closed a position left over from an earlier run)');
  }

  // ---- 1. a stop-loss fired by the keeper --------------------------------------------------------------------
  step('1. Stop-loss: signed by the trader, stored by the API, fired by the keeper');
  const s = await openLong();
  await sleep(3_000);
  // "Fires when the mark is at or below the trigger". The trigger is set 1% above the mark, so it is already met.
  const nonce1 = BigInt(Date.now());
  const so = await signedOrder(nonce1, (s.mark.priceE18 * 101n) / 100n, false);
  const placed = await postOrder(so);
  if (placed.status !== 201) throw new Error(`order refused: ${JSON.stringify(placed.json)}`);
  ok('order accepted by the API (HTTP 201)');
  if ((await account()).openOrders.length !== 1) throw new Error('the order is not in the database');
  ok('order is stored in the database');

  await waitFor('the keeper to close the position', async () => (await position()).size === 0n);
  ok('the keeper executed the order and the position is closed');
  // The keeper marks the order filled and the indexer copies the trade a moment after the transaction lands.
  const acc1 = await waitFor('the order to leave the open list and the trade to be indexed', async () => {
    const a = await account();
    return a.openOrders.length === 0 && a.recentTrades.some((t: any) => t.path === 1) ? a : null;
  }, 30_000);
  const viaOrder = acc1.recentTrades.find((t: any) => t.path === 1);
  ok(`the order is no longer open and the indexer recorded it as an order trade (realised P&L ${viaOrder.realizedPnlUsdg})`);

  // ---- 2. cancel and refusals --------------------------------------------------------------------------------
  step('2. Cancelling, and what the API refuses');
  const nonce2 = BigInt(Date.now()) + 1n;
  const far = await signedOrder(nonce2, 1n * 10n ** 18n, false); // triggers only if the mark falls to $1: never
  if ((await postOrder(far)).status !== 201) throw new Error('second order refused');
  if ((await account()).openOrders.length !== 1) throw new Error('second order not stored');
  const dup = await postOrder(far);
  if (dup.status !== 409) throw new Error(`duplicate nonce should be 409, got ${dup.status}`);
  ok('a duplicate nonce is refused (409)');

  const forged = await signedOrder(nonce2 + 1n, 1n * 10n ** 18n, false);
  const wrong = await postOrder({ ...forged, signature: far.signature });
  if (wrong.status !== 422) throw new Error(`a signature that does not match should be 422, got ${wrong.status}`);
  ok('an order whose signature does not match is refused (422)');

  const stranger = await api('DELETE', `/v1/orders/${nonce2}`, { trader: trader.account.address, signature: await owner.account.signMessage({ message: `plankton:cancel-order:${nonce2}` }) });
  if (stranger.status !== 422) throw new Error(`someone else cancelling should be 422, got ${stranger.status}`);
  ok('someone else cannot cancel your order (422)');

  const cancel = await api('DELETE', `/v1/orders/${nonce2}`, { trader: trader.account.address, signature: await trader.account.signMessage({ message: `plankton:cancel-order:${nonce2}` }) });
  if (cancel.status !== 200 || cancel.json.cancelledOffChain !== true) throw new Error(`cancel failed: ${JSON.stringify(cancel.json)}`);
  if ((await account()).openOrders.length !== 0) throw new Error('the cancelled order is still open');
  ok('a signed cancel removes it; the response also carries the on-chain cancel call');

  // ---- 3. a liquidation ---------------------------------------------------------------------------------------
  step('3. Liquidation: the maintenance margin is raised so a fresh position falls below it');
  await sleep(3_000);
  const s2 = await openLong();
  const keeperBefore = await client.readContract({ address: dep.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [KEEPER] });
  // Raising the requirement is a tightening, so the contract applies it at once (no 24h wait).
  const tight = { ...s2.cfg, maintenanceMarginBps: 6_000 };
  await send(owner, { address: dep.exchange, abi: exchangeAbi, functionName: 'scheduleMarket', args: [market, tight] });
  ok('maintenance margin raised to 60% (instant: it is a tightening)');

  await waitFor('the keeper to liquidate', async () => (await position()).size === 0n, 120_000);
  ok('the keeper liquidated the position');
  const keeperAfter = await client.readContract({ address: dep.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [KEEPER] });
  if (keeperAfter <= keeperBefore) throw new Error('the keeper should have earned the liquidation reward');
  ok(`the keeper earned ${formatUsdg(keeperAfter - keeperBefore)} USDG (half of the 5% penalty on the margin)`);
  const acc3 = await waitFor('the indexer to record the liquidation', async () => {
    const a = await account();
    return a.recentTrades.some((t: any) => t.path === 3) ? a : null;
  });
  ok(`the indexer recorded it as a liquidation (${acc3.recentTrades.filter((t: any) => t.path === 3).length} liquidation trade)`);
  console.log('\nALL STEPS PASSED');
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
