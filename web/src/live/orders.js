// The messages a trader signs. They must match the contracts exactly (Exchange.ORDER_TYPEHASH, USDG's permit domain):
// packages/chain/test/web-abi.test.ts compares these definitions with the backend's.

export const ORDER_KIND = { limit: 0, stop: 1, takeProfit: 2, stopLoss: 3, market: 4 };
// Kind 4 has no trigger: the contract (Exchange.executeOrder) and the keeper fill it as soon as it arrives.
export const KIND_LABEL = { 0: 'Limit', 1: 'Stop', 2: 'Take profit', 3: 'Stop loss', 4: 'Market' };

/** How far the execution price may sit from the mark when a keeper fills the order. Wider for protective exits: a stop must get out. */
export const ENTRY_SLIPPAGE_BPS = 250;
export const PROTECT_SLIPPAGE_BPS = 500;
/** A gasless market order fills seconds after it is signed, so it allows less than a resting entry order. */
export const MARKET_SLIPPAGE_BPS = 150;
/** A gasless market order that the keeper cannot fill in this time lapses: it never fills later at a surprising price. */
export const MARKET_ORDER_LIFETIME_SEC = 120n;
/** Deposited USDG kept spare above margin and fee before a market order goes gasless (the fee can tick up at the fill). */
const GASLESS_BUFFER_USDG = 0.01;

/** A market order is gasless when the deposited collateral already covers its margin and fee: the keeper fills it. */
export const canGoGasless = (collateral, margin, fee) => collateral >= margin + fee + GASLESS_BUFFER_USDG;

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

/**
 * A gasless market order: the trader signs it (no gas) and the keeper fills it at once, paying the gas. Opens draw the
 * margin and fee from collateral already deposited in the exchange. `sizeDeltaE18` is signed (negative is short). `lifetimeSec`
 * is how long the order stays valid once `validAfter` passes (a scheduled TWAP slice uses a longer window than an instant order).
 */
export function marketOrder({ marketId, trader, sizeDeltaE18, marginUsdg, validAfter, nonce, maxSlippageBps = MARKET_SLIPPAGE_BPS, lifetimeSec = MARKET_ORDER_LIFETIME_SEC }) {
  return {
    marketId,
    trader,
    kind: ORDER_KIND.market,
    sizeDeltaE18,
    sizeBps: 0,
    triggerE18: 0n,
    triggerAbove: false,
    reduceOnly: false,
    maxSlippageBps,
    marginUsdg,
    validAfter,
    expiry: validAfter + BigInt(lifetimeSec),
    nonce,
  };
}

/** A gasless close of `sizeBps` of the position (10_000 = all). Reduce-only, so it can never open or flip a position. */
export function marketCloseOrder({ marketId, trader, sizeBps, validAfter, nonce, maxSlippageBps = ENTRY_SLIPPAGE_BPS }) {
  if (!(sizeBps > 0 && sizeBps <= 10_000)) throw new Error('close size must be 1 to 10000 bps');
  return {
    marketId,
    trader,
    kind: ORDER_KIND.market,
    sizeDeltaE18: 0n,
    sizeBps,
    triggerE18: 0n,
    triggerAbove: false,
    reduceOnly: true,
    maxSlippageBps,
    marginUsdg: 0n,
    validAfter,
    expiry: validAfter + MARKET_ORDER_LIFETIME_SEC,
    nonce,
  };
}

// ---------------------------------------------------------------- ladders

/** A ladder is a set of ordinary limit orders: each needs its own signature, so the count stays small. */
export const MAX_LADDER_STEPS = 5;
export const MIN_LADDER_STEPS = 2;

const priceE18 = (price) => BigInt(Math.round(price * 1e8)) * 10n ** 10n;

/**
 * Splits one entry into `steps` limit orders at evenly spaced prices from `fromPrice` to `toPrice`, sharing the margin
 * equally. Each rung is sized like a single limit order: margin × leverage × headroom at its own price.
 */
export function ladderRungs({ fromPrice, toPrice, steps, marginUsdg, leverage, headroom = 0.98, digits = 4 }) {
  if (!(Number.isInteger(steps) && steps >= MIN_LADDER_STEPS && steps <= MAX_LADDER_STEPS)) throw new Error(`a ladder has ${MIN_LADDER_STEPS} to ${MAX_LADDER_STEPS} steps`);
  const per = marginUsdg / BigInt(steps);
  return Array.from({ length: steps }, (_, i) => {
    const price = Number((fromPrice + ((toPrice - fromPrice) * i) / (steps - 1)).toFixed(digits));
    const triggerE18 = priceE18(price);
    const notionalUsdg = (per * BigInt(Math.round(leverage * headroom * 1000))) / 1000n;
    const sizeE18 = triggerE18 > 0n ? (notionalUsdg * 10n ** 30n) / triggerE18 : 0n;
    return { price, triggerE18, marginUsdg: per, notionalUsdg, sizeE18 };
  });
}

/** Why a ladder cannot be placed, or null. A buy ladder sits wholly below the price, a sell ladder wholly above it. */
export function ladderProblem({ side, fromPrice, toPrice, markPrice, steps, marginUsdg }) {
  if (!(fromPrice > 0) || !(toPrice > 0)) return 'Enter both ladder prices above 0.';
  if (fromPrice === toPrice) return 'The ladder needs two different prices.';
  if (!(steps >= MIN_LADDER_STEPS && steps <= MAX_LADDER_STEPS)) return `Choose ${MIN_LADDER_STEPS} to ${MAX_LADDER_STEPS} steps.`;
  if (marginUsdg / BigInt(steps) < 100_000n) return 'Each step needs at least 0.10 USDG of margin.';
  const hi = Math.max(fromPrice, toPrice);
  const lo = Math.min(fromPrice, toPrice);
  if (side === 'long' && hi >= markPrice) return 'A buy ladder must sit below the current price. Use Market to trade now.';
  if (side === 'short' && lo <= markPrice) return 'A sell ladder must sit above the current price. Use Market to trade now.';
  return null;
}
