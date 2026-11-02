import { parseSignature } from 'viem';
import { exchangeAbi, payoutDeskAbi, vaultAbi } from './abis.js';
import { cancelMessage, orderBody, orderTypedData, permitTypedData } from './orders.js';
import { revertName } from './errors.js';
import { big } from './units.js';

// Every action that moves money or signs for the trader. Each takes a `ctx` so the same code runs in the browser (wagmi) and
// in tests (fakes):
//   ctx.address, ctx.chainId, ctx.contracts { exchange, vault, usdg, payoutDesk }
//   ctx.api { get(path), post(path, body), del(path, body) }
//   ctx.signTypedData(typedData) -> hex signature      ctx.signMessage(text) -> hex signature
//   ctx.sendTx({ address, abi, functionName, args }) -> hash   (estimates gas with a margin; throws on a simulated revert)
//   ctx.waitForReceipt(hash) -> receipt (throws if the transaction reverted)
//   ctx.onStep(name, detail) optional progress callback for the screen

const step = (ctx, name, detail) => ctx.onStep?.(name, detail);

/** Retry a quote-and-send when the quote expired or the mark moved while the wallet was open. */
const RETRYABLE = new Set(['Expired', 'QuoteExpired', 'StaleSequence', 'SequenceGap']);
const MAX_QUOTE_ATTEMPTS = 3;
/** The permit covers the shortfall plus this much, so a fresh quote with a slightly different fee still fits under it. */
const permitBuffer = (need) => (need / 100n > 10_000n ? need / 100n : 10_000n);

const splitSignature = (hex) => {
  const { r, s, v, yParity } = parseSignature(hex);
  return { r, s, v: Number(v ?? BigInt(yParity) + 27n) };
};

/** The wire quote (decimal strings) as the contract's TradeQuote struct. */
export const toQuoteArg = (q) => ({
  marketId: q.marketId,
  trader: q.trader,
  sizeDeltaE18: big(q.sizeDeltaE18),
  execPriceE18: big(q.execPriceE18),
  feeUsdg: big(q.feeUsdg),
  maxLeverageE18: big(q.maxLeverageE18),
  markSequence: big(q.markSequence),
  nonce: big(q.nonce),
  expiry: big(q.expiry),
});

async function confirmed(ctx, call) {
  step(ctx, 'wallet');
  const hash = await ctx.sendTx(call);
  step(ctx, 'confirming', hash);
  await ctx.waitForReceipt(hash);
  step(ctx, 'done', hash);
  return hash;
}

async function chainNow(ctx) {
  return big((await ctx.api.get('/v1/config')).chainTimeSec);
}

/** A USDG permit signature for `spender`, covering `value`. */
async function signPermit(ctx, { spender, value, nonce, deadline }) {
  step(ctx, 'sign-permit');
  const sig = await ctx.signTypedData(permitTypedData({ chainId: ctx.chainId, usdg: ctx.contracts.usdg, owner: ctx.address, spender, value, nonce, deadline }));
  return { ...splitSignature(sig), value, deadline };
}

/**
 * Sends a server-signed quote: fetches it, signs a USDG permit when the wallet's deposited collateral does not cover
 * the margin and fee, and calls execute (or permitAndExecute) in one transaction.
 *
 * Quotes live about 20 seconds and a wallet prompt can take longer, so the permit is signed first (for the shortfall plus a
 * small buffer) and the quote is fetched again afterwards; an Expired revert fetches yet another.
 */
export async function sendQuoted(ctx, getQuote, marginUsdg) {
  let permit = null;
  step(ctx, 'quote');
  let q = await getQuote();
  if (q.permit) {
    const need = big(q.permit.message.value);
    const value = need + permitBuffer(need);
    permit = await signPermit(ctx, { spender: ctx.contracts.exchange, value, nonce: big(q.permit.message.nonce), deadline: big(q.permit.message.deadline) });
    step(ctx, 'quote');
    q = await getQuote(); // fresh: the wallet prompt used up some of the first quote's 20 seconds
    if (q.permit && big(q.permit.message.value) > permit.value) {
      // The fee grew past the buffer (the price moved a lot): sign again for the new figure.
      const more = big(q.permit.message.value);
      permit = await signPermit(ctx, { spender: ctx.contracts.exchange, value: more + permitBuffer(more), nonce: big(q.permit.message.nonce), deadline: big(q.permit.message.deadline) });
      q = await getQuote();
    }
  }
  for (let attempt = 1; ; attempt++) {
    const quote = toQuoteArg(q.quote);
    const call = permit
      ? { address: ctx.contracts.exchange, abi: exchangeAbi, functionName: 'permitAndExecute', args: [permit.value, permit.deadline, permit.v, permit.r, permit.s, quote, q.signature, marginUsdg] }
      : { address: ctx.contracts.exchange, abi: exchangeAbi, functionName: 'execute', args: [quote, q.signature, marginUsdg] };
    try {
      return await confirmed(ctx, call);
    } catch (err) {
      if (attempt >= MAX_QUOTE_ATTEMPTS || !RETRYABLE.has(revertName(err))) throw err;
      step(ctx, 'quote');
      q = await getQuote();
    }
  }
}

/** Open or add to a position. `sizeDeltaE18` is signed (negative is short) and normally comes from the ticket preview. */
export function openTrade(ctx, { symbol, sizeDeltaE18, marginUsdg }) {
  const body = { market: symbol, trader: ctx.address, sizeDeltaE18: sizeDeltaE18.toString(), marginUsdg: marginUsdg.toString() };
  return sendQuoted(ctx, () => ctx.api.post('/v1/quote/trade', body), marginUsdg);
}

/**
 * Close part or all of a position with a signed quote. When the quote service cannot answer, the API error carries the
 * closeAtMark call (err.body.closeAtMark) and the screen offers closeAtMarkTx instead.
 */
export function closeTrade(ctx, { symbol, sizeBps }) {
  const body = { market: symbol, trader: ctx.address, sizeBps };
  return sendQuoted(ctx, () => ctx.api.post('/v1/quote/close', body), 0n);
}

/** The permissionless exit: no quote, no backend, just the on-chain mark. */
export function closeAtMarkTx(ctx, { marketId, sizeBps }) {
  return confirmed(ctx, { address: ctx.contracts.exchange, abi: exchangeAbi, functionName: 'closeAtMark', args: [marketId, sizeBps] });
}

// ---------------------------------------------------------------- collateral

/** The permit nonce and a deadline ten minutes out, read at the moment of signing. */
async function permitParams(ctx) {
  const [state, now] = await Promise.all([ctx.api.get(`/v1/accounts/${ctx.address}/state`), chainNow(ctx)]);
  return { nonce: big(state.usdgNonce), deadline: now + 600n };
}

export async function depositCollateral(ctx, amountUsdg) {
  const { nonce, deadline } = await permitParams(ctx);
  const p = await signPermit(ctx, { spender: ctx.contracts.exchange, value: amountUsdg, nonce, deadline });
  return confirmed(ctx, { address: ctx.contracts.exchange, abi: exchangeAbi, functionName: 'depositWithPermit', args: [amountUsdg, p.deadline, p.v, p.r, p.s] });
}

export function withdrawCollateral(ctx, amountUsdg) {
  return confirmed(ctx, { address: ctx.contracts.exchange, abi: exchangeAbi, functionName: 'withdraw', args: [amountUsdg] });
}

/** Adds margin to an open position, depositing first if the free collateral does not cover it. */
export async function addMarginTx(ctx, { marketId, amountUsdg, collateralUsdg }) {
  if (collateralUsdg < amountUsdg) await depositCollateral(ctx, amountUsdg - collateralUsdg);
  return confirmed(ctx, { address: ctx.contracts.exchange, abi: exchangeAbi, functionName: 'addMargin', args: [marketId, amountUsdg] });
}

// ---------------------------------------------------------------- trigger orders

/** Signs an order and hands it to the API; a keeper executes it once the trigger is met. Nothing is sent on-chain. */
export async function placeOrder(ctx, order) {
  step(ctx, 'sign-order');
  const sig = await ctx.signTypedData(orderTypedData(ctx.chainId, ctx.contracts.exchange, order));
  step(ctx, 'submit');
  return ctx.api.post('/v1/orders', orderBody(order, sig));
}

/** Cancels off-chain with a signed message. The response also has the on-chain cancel call for a stronger guarantee. */
export async function cancelOrderRequest(ctx, nonce) {
  step(ctx, 'sign-cancel');
  const signature = await ctx.signMessage(cancelMessage(nonce));
  return ctx.api.del(`/v1/orders/${nonce}`, { trader: ctx.address, signature });
}

export function cancelOrderOnChain(ctx, nonce) {
  return confirmed(ctx, { address: ctx.contracts.exchange, abi: exchangeAbi, functionName: 'cancelOrder', args: [big(nonce)] });
}

// ---------------------------------------------------------------- the Counter (liquidity pool)

/** Requests a Counter deposit with one signature. It settles after the next mark, at the worse of two prices. */
export async function counterDeposit(ctx, assetsUsdg) {
  const { nonce, deadline } = await permitParams(ctx);
  const p = await signPermit(ctx, { spender: ctx.contracts.vault, value: assetsUsdg, nonce, deadline });
  return confirmed(ctx, { address: ctx.contracts.vault, abi: vaultAbi, functionName: 'requestDepositWithPermit', args: [assetsUsdg, p.deadline, p.v, p.r, p.s] });
}

export function counterWithdraw(ctx, shares) {
  return confirmed(ctx, { address: ctx.contracts.vault, abi: vaultAbi, functionName: 'requestWithdraw', args: [shares] });
}

export function claimPayout(ctx, id) {
  return confirmed(ctx, { address: ctx.contracts.payoutDesk, abi: payoutDeskAbi, functionName: 'claim', args: [big(id)] });
}
