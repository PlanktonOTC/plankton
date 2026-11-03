// The messages a trader signs. They must match the contracts exactly (Exchange.ORDER_TYPEHASH, USDG's permit domain):
// packages/chain/test/web-abi.test.ts compares these definitions with the backend's.

export const ORDER_KIND = { limit: 0, stop: 1, takeProfit: 2, stopLoss: 3 };
export const KIND_LABEL = { 0: 'Limit', 1: 'Stop', 2: 'Take profit', 3: 'Stop loss', 4: 'TWAP slice' };

/** How far the execution price may sit from the mark when a keeper fills the order. Wider for protective exits: a stop must get out. */
export const ENTRY_SLIPPAGE_BPS = 250;
export const PROTECT_SLIPPAGE_BPS = 500;

export const orderTypes = {
  Order: [
    { name: 'marketId', type: 'bytes32' },
    { name: 'trader', type: 'address' },
    { name: 'kind', type: 'uint8' },
    { name: 'sizeDeltaE18', type: 'int256' },
    { name: 'sizeBps', type: 'uint16' },
    { name: 'triggerE18', type: 'uint256' },
    { name: 'triggerAbove', type: 'bool' },
    { name: 'reduceOnly', type: 'bool' },
    { name: 'maxSlippageBps', type: 'uint16' },
    { name: 'marginUsdg', type: 'uint128' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
};

export const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export const exchangeDomain = (chainId, exchange) => ({ name: 'PlanktonExchange', version: '1', chainId, verifyingContract: exchange });
/** USDG's own EIP-2612 domain. Its eip712Domain() reverts on-chain, so the name and version are fixed here. */
export const usdgDomain = (chainId, usdg) => ({ name: 'Global Dollar', version: '1', chainId, verifyingContract: usdg });

export function permitTypedData({ chainId, usdg, owner, spender, value, nonce, deadline }) {
  return { domain: usdgDomain(chainId, usdg), types: permitTypes, primaryType: 'Permit', message: { owner, spender, value, nonce, deadline } };
}

export const orderTypedData = (chainId, exchange, order) => ({
  domain: exchangeDomain(chainId, exchange),
  types: orderTypes,
  primaryType: 'Order',
  message: order,
});

/** The text a trader signs to cancel an order off-chain. The API checks it with verifyMessage. */
export const cancelMessage = (nonce) => `plankton:cancel-order:${nonce}`;

/**
 * A random order id. The contract accepts any uint64, but the API stores orders in a Postgres bigint, which stops at 2^63 - 1,
 * so the top bit is cleared. 63 random bits still make a collision negligible.
 */
export const MAX_ORDER_NONCE = (1n << 63n) - 1n;
export function newNonce(cryptoImpl = globalThis.crypto) {
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(8));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n) & MAX_ORDER_NONCE;
}

/** Whether the mark must rise to (true) or fall to (false) the trigger, for an entry order by the side it opens. */
export const entryTriggerAbove = (kind, side) => (kind === 'limit' ? side === 'short' : side === 'long');
/** Same for a protective exit by the side of the POSITION it protects: a long's take-profit waits for a rise, its stop for a fall. */
export const protectionTriggerAbove = (kind, positionSide) => (kind === 'takeProfit' ? positionSide === 'long' : positionSide === 'short');

/** A limit or stop that opens (or adds to) a position when the mark reaches the trigger. `sizeE18` is the unsigned token amount. */
export function entryOrder({ type, side, marketId, trader, sizeE18, triggerE18, marginUsdg, validAfter, expiry, nonce, maxSlippageBps = ENTRY_SLIPPAGE_BPS }) {
  if (type !== 'limit' && type !== 'stop') throw new Error('entry orders are limit or stop');
  return {
    marketId,
    trader,
    kind: ORDER_KIND[type],
    sizeDeltaE18: side === 'long' ? sizeE18 : -sizeE18,
    sizeBps: 0,
    triggerE18,
    triggerAbove: entryTriggerAbove(type, side),
    reduceOnly: false,
    maxSlippageBps,
    marginUsdg,
    validAfter,
    expiry,
    nonce,
  };
}

/** A take-profit or stop-loss that closes the whole position when the trigger is reached. It is reduce-only and tied to the current position. */
export function protectionOrder({ kind, positionSide, marketId, trader, triggerE18, validAfter, expiry, nonce, maxSlippageBps = PROTECT_SLIPPAGE_BPS }) {
  if (kind !== 'takeProfit' && kind !== 'stopLoss') throw new Error('protection is take-profit or stop-loss');
  return {
    marketId,
    trader,
    kind: ORDER_KIND[kind],
    sizeDeltaE18: 0n,
    sizeBps: 10_000,
    triggerE18,
    triggerAbove: protectionTriggerAbove(kind, positionSide),
    reduceOnly: true,
    maxSlippageBps,
    marginUsdg: 0n,
    validAfter,
    expiry,
    nonce,
  };
}

/** The JSON the API's POST /v1/orders accepts: every 64-bit-or-wider number as a decimal string. */
export function orderBody(order, signature) {
  const text = (v) => v.toString();
  return {
    marketId: order.marketId,
    trader: order.trader,
    kind: order.kind,
    sizeDeltaE18: text(order.sizeDeltaE18),
    sizeBps: order.sizeBps,
    triggerE18: text(order.triggerE18),
    triggerAbove: order.triggerAbove,
    reduceOnly: order.reduceOnly,
    maxSlippageBps: order.maxSlippageBps,
    marginUsdg: text(order.marginUsdg),
    validAfter: text(order.validAfter),
    expiry: text(order.expiry),
    nonce: text(order.nonce),
    signature,
  };
}

/**
 * Checks protective levels against the entry/reference price the way the exchange will treat them. Returns the first
 * problem as a sentence, or null. Prices are decimal numbers (display-side check; the keeper decides at fill time).
 */
export function protectionProblem(side, reference, takeProfit, stopLoss) {
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const tp = num(takeProfit);
  const sl = num(stopLoss);
  if (tp !== null && (!Number.isFinite(tp) || tp <= 0)) return 'Take profit must be a positive price.';
  if (sl !== null && (!Number.isFinite(sl) || sl <= 0)) return 'Stop loss must be a positive price.';
  if (tp !== null && (side === 'long' ? tp <= reference : tp >= reference)) return `Take profit must be ${side === 'long' ? 'above' : 'below'} the current price.`;
  if (sl !== null && (side === 'long' ? sl >= reference : sl <= reference)) return `Stop loss must be ${side === 'long' ? 'below' : 'above'} the current price.`;
  return null;
}
