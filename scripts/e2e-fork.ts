// End-to-end check against the local anvil fork (see docs/local-fork.md). It plays the roles of an LP and a trader:
//   1. LP deposits 100,000 USDG into the Counter and the request is settled after the next mark.
//   2. Trader asks the API for a quote, signs the USDG permit, and opens a long with ONE transaction (permitAndExecute).
//   3. Trader asks for a close quote and exits.
//   4. Trader opens again and exits with closeAtMark, which needs no quote service.
// Needs: anvil + contracts + markets applied + `scripts/fork-stack.ps1` running. Uses anvil's public test keys.
import { erc20Abi, parseSignature, type Hex } from 'viem';
import { loadDeployment, loadMarkets } from '@plankton/config';
import { createChainClient, createChainWallet, exchangeAbi, quoteWire, signature as sigSchema, toJson, vaultAbi, marketIdFor, oracleAbi, writeWithGasMargin } from '@plankton/chain';
import { formatUsdg, formatE18 } from '@plankton/core';
import { z } from 'zod';

const RPC = 'http://127.0.0.1:8545';
const API = 'http://127.0.0.1:8787';
const LP_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const; // anvil 0
const TRADER_KEY = '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e' as const; // anvil 6

const dep = loadDeployment();
const client = createChainClient([RPC]);
const lp = createChainWallet([RPC], LP_KEY);
const trader = createChainWallet([RPC], TRADER_KEY);
// Trade the first configured market, with sizes in dollars so any share price works.
const first = loadMarkets().markets[0];
if (!first) throw new Error('config/markets.json has no markets');
const SYMBOL = first.symbol;
const market = marketIdFor(SYMBOL, first.stockToken as `0x${string}`);
async function sizeForUsd(usd: number): Promise<bigint> {
  const mark = await client.readContract({ address: dep.oracle, abi: oracleAbi, functionName: 'markOf', args: [market] });
  return BigInt(Math.floor((usd / (Number(mark.priceE18) / 1e18)) * 1e6)) * 10n ** 12n;
}

const ok = (m: string) => console.log(`  ok   ${m}`);
const step = (m: string) => console.log(`\n${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function send(w: typeof lp, req: Parameters<typeof lp.wallet.writeContract>[0]): Promise<Hex> {
  const hash = await writeWithGasMargin(client, w, req);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  return hash;
}
async function api(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: toJson(body) });
  const j = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(j)}`);
  return j;
}
const quoteResponse = z.object({ quote: quoteWire, signature: sigSchema, permit: z.any().nullable(), reducing: z.boolean() });

async function main() {
  // ---- 1. LP deposit -------------------------------------------------------------------------------------------
  step('1. LP deposits 100,000 USDG into the Counter');
  const epochBefore = await client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'markEpoch' });
  await send(lp, { address: dep.usdg, abi: erc20Abi, functionName: 'approve', args: [dep.vault, 100_000_000_000n] });
  await send(lp, { address: dep.vault, abi: vaultAbi, functionName: 'requestDeposit', args: [100_000_000_000n] });
  ok('deposit requested (held in escrow until the next mark)');
  // Marks go on-chain only when someone is about to trade, so ask the mark service for one (the same call the API makes before a quote).
  const pub = await fetch(`http://127.0.0.1:8788/publish/${SYMBOL}`, { method: 'POST', headers: { authorization: 'Bearer local-fork-token-0123456789' } });
  if (!pub.ok) throw new Error(`mark service would not publish a ${SYMBOL} mark (HTTP ${pub.status}): is it warmed up and is the publisher funded?`);
  for (let i = 0; i < 40; i++) {
    const epoch = await client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'markEpoch' });
    if (epoch > epochBefore) break;
    if (i === 39) throw new Error('no new mark was published in 2 minutes: is the mark service running with a publisher?');
    await sleep(3_000);
  }
  await send(lp, { address: dep.vault, abi: vaultAbi, functionName: 'settle', args: [50n] });
  const nav = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'navUsdg' });
  if (nav < 99_000_000_000n) throw new Error(`NAV is ${formatUsdg(nav)}, expected about 100000`);
  ok(`Counter NAV is ${formatUsdg(nav, 2)} USDG`);

  // ---- 2. trader opens a long with one transaction -------------------------------------------------------------
  step('2. Trader opens a long: quote, permit, then permitAndExecute in one transaction');
  const size1 = await sizeForUsd(200); // about $200 of exposure on $120 of margin
  const q1 = quoteResponse.parse(await api('/v1/quote/trade', { market: SYMBOL, trader: trader.account.address, sizeDeltaE18: size1, marginUsdg: '120000000' }));
  ok(`quote: buy ${formatE18(size1, 4)} ${SYMBOL} at ${formatE18(q1.quote.execPriceE18, 4)}, fee ${formatUsdg(q1.quote.feeUsdg)} USDG`);
  if (!q1.permit) throw new Error('expected a permit (the trader has no collateral deposited)');
  const p = q1.permit;
  const permitSig = parseSignature(
    await trader.account.signTypedData({
      domain: { ...p.domain, chainId: Number(p.domain.chainId) },
      types: p.types,
      primaryType: 'Permit',
      message: { owner: p.message.owner, spender: p.message.spender, value: BigInt(p.message.value), nonce: BigInt(p.message.nonce), deadline: BigInt(p.message.deadline) },
    }),
  );
  const v = Number(permitSig.v ?? BigInt(permitSig.yParity) + 27n);
  await send(trader, {
    address: dep.exchange,
    abi: exchangeAbi,
    functionName: 'permitAndExecute',
    args: [BigInt(p.message.value), BigInt(p.message.deadline), v, permitSig.r, permitSig.s, q1.quote, q1.signature, 120_000_000n],
  });
  const pos = await client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'positionOf', args: [trader.account.address, market] });
  if (pos.size !== size1) throw new Error(`unexpected position size ${pos.size}`);
  ok(`position open: ${formatE18(pos.size, 4)} ${SYMBOL}, entry ${formatE18(pos.entry, 4)}, margin ${formatUsdg(BigInt(pos.margin))} USDG`);

  // ---- 3. trader closes with a quote ---------------------------------------------------------------------------
  step('3. Trader closes the whole position with a signed close quote');
  await sleep(3_000); // the contract forbids reducing in the same block as opening
  const q2 = quoteResponse.parse(await api('/v1/quote/close', { market: SYMBOL, trader: trader.account.address, sizeBps: 10_000 }));
  await send(trader, { address: dep.exchange, abi: exchangeAbi, functionName: 'execute', args: [q2.quote, q2.signature, 0n] });
  const after = await client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'positionOf', args: [trader.account.address, market] });
  if (after.size !== 0n) throw new Error('position should be closed');
  const coll = await client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'collateral', args: [trader.account.address] });
  ok(`closed. Collateral returned: ${formatUsdg(coll)} USDG (started with 120, so the cost is spread + fees)`);

  // ---- 4. exit with closeAtMark (no quote service) -------------------------------------------------------------
  step('4. Trader opens again, then exits with closeAtMark: no quote service involved');
  const q3 = quoteResponse.parse(await api('/v1/quote/trade', { market: SYMBOL, trader: trader.account.address, sizeDeltaE18: await sizeForUsd(150), marginUsdg: '100000000' }));
  await send(trader, { address: dep.exchange, abi: exchangeAbi, functionName: 'execute', args: [q3.quote, q3.signature, 100_000_000n] });
  await sleep(3_000);
  await send(trader, { address: dep.exchange, abi: exchangeAbi, functionName: 'closeAtMark', args: [market, 10_000] });
  const end = await client.readContract({ address: dep.exchange, abi: exchangeAbi, functionName: 'positionOf', args: [trader.account.address, market] });
  if (end.size !== 0n) throw new Error('closeAtMark should have closed the position');
  ok('closeAtMark closed it');

  const counter = (await (await fetch(`${API}/v1/counter`)).json()) as Record<string, string>;
  console.log('\nCounter after the round trips:', JSON.stringify({ navUsdg: counter.navUsdg, cashUsdg: counter.cashUsdg }));
  console.log('\nALL STEPS PASSED');
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
