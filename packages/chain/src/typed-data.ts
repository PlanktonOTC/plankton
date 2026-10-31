import type { Address, Hex } from 'viem';
import { ROBINHOOD_CHAIN_ID, USDG_ADDRESS } from './chain.ts';

// EIP-712 definitions. They must match the contracts exactly: Exchange.QUOTE_TYPEHASH / ORDER_TYPEHASH and
// MarkOracle.ATTESTATION_TYPEHASH. USDG's domain is hardcoded because its eip712Domain() and version() revert.

export const quoteTypes = {
  TradeQuote: [
    { name: 'marketId', type: 'bytes32' },
    { name: 'trader', type: 'address' },
    { name: 'sizeDeltaE18', type: 'int256' },
    { name: 'execPriceE18', type: 'uint256' },
    { name: 'feeUsdg', type: 'uint256' },
    { name: 'maxLeverageE18', type: 'uint64' },
    { name: 'markSequence', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

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
} as const;

export const attestationTypes = {
  Attestation: [
    { name: 'marketId', type: 'bytes32' },
    { name: 'markE18', type: 'uint256' },
    { name: 'refCloseE18', type: 'uint256' },
    { name: 'confidenceBps', type: 'uint16' },
    { name: 'status', type: 'uint8' },
    { name: 'sequence', type: 'uint64' },
    { name: 'observedAt', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

export const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const exchangeDomain = (exchange: Address) =>
  ({ name: 'PlanktonExchange', version: '1', chainId: ROBINHOOD_CHAIN_ID, verifyingContract: exchange }) as const;

export const markDomain = (oracle: Address) =>
  ({ name: 'PlanktonMark', version: '1', chainId: ROBINHOOD_CHAIN_ID, verifyingContract: oracle }) as const;

export const usdgDomain = { name: 'Global Dollar', version: '1', chainId: ROBINHOOD_CHAIN_ID, verifyingContract: USDG_ADDRESS } as const;

export interface TradeQuoteMsg {
  marketId: Hex;
  trader: Address;
  sizeDeltaE18: bigint;
  execPriceE18: bigint;
  feeUsdg: bigint;
  maxLeverageE18: bigint;
  markSequence: bigint;
  nonce: bigint;
  expiry: bigint;
}

export interface OrderMsg {
  marketId: Hex;
  trader: Address;
  kind: number;
  sizeDeltaE18: bigint;
  sizeBps: number;
  triggerE18: bigint;
  triggerAbove: boolean;
  reduceOnly: boolean;
  maxSlippageBps: number;
  marginUsdg: bigint;
  validAfter: bigint;
  expiry: bigint;
  nonce: bigint;
}

export interface AttestationMsg {
  marketId: Hex;
  markE18: bigint;
  refCloseE18: bigint;
  confidenceBps: number;
  status: number;
  sequence: bigint;
  observedAt: bigint;
  expiry: bigint;
}

/** The ready-to-sign EIP-2612 permit for USDG, so the wallet shows one prompt for permit + deposit + open. */
export function permitTypedData(owner: Address, spender: Address, value: bigint, nonce: bigint, deadline: bigint) {
  return {
    domain: usdgDomain,
    types: permitTypes,
    primaryType: 'Permit' as const,
    message: { owner, spender, value, nonce, deadline },
  };
}
