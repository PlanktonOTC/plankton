import { z } from 'zod';
import type { AttestationMsg, BellQuoteMsg, BellSettlementMsg, OrderMsg, SeriesReferenceMsg, TradeQuoteMsg } from './typed-data.ts';

// JSON between services carries every 64+ bit number as a decimal string. These schemas parse them back to bigint.

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as `0x${string}`);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v as `0x${string}`);
const uint = z.string().regex(/^\d+$/).transform((v) => BigInt(v));
const int = z.string().regex(/^-?\d+$/).transform((v) => BigInt(v));

export const quoteWire = z.object({
  marketId: hex32,
  trader: address,
  sizeDeltaE18: int,
  execPriceE18: uint,
  feeUsdg: uint,
  maxLeverageE18: uint,
  markSequence: uint,
  nonce: uint,
  expiry: uint,
});

export const orderWire = z.object({
  marketId: hex32,
  trader: address,
  kind: z.number().int().min(0).max(4),
  sizeDeltaE18: int,
  sizeBps: z.number().int().min(0).max(10_000),
  triggerE18: uint,
  triggerAbove: z.boolean(),
  reduceOnly: z.boolean(),
  maxSlippageBps: z.number().int().min(0).max(10_000),
  marginUsdg: uint,
  validAfter: uint,
  expiry: uint,
  nonce: uint,
});

export const attestationWire = z.object({
  marketId: hex32,
  markE18: uint,
  refCloseE18: uint,
  confidenceBps: z.number().int().min(0).max(65_535),
  status: z.number().int().min(1).max(5),
  sequence: uint,
  observedAt: uint,
  expiry: uint,
});

export const bellQuoteWire = z.object({
  trader: address,
  marketId: hex32,
  expiry: uint,
  strikeE18: uint,
  optionType: z.number().int().min(0).max(1),
  payoutUsdg: uint,
  premiumUsdg: uint,
  markSequence: uint,
  validUntil: uint,
  nonce: uint,
});

export const seriesReferenceWire = z.object({
  marketId: hex32,
  expiry: uint,
  sourcePriceA: uint,
  sourcePriceB: uint,
  sourceIdA: hex32,
  sourceIdB: hex32,
  observedAtA: uint,
  observedAtB: uint,
  nonce: uint,
});

export const bellSettlementWire = z.object({
  marketId: hex32,
  expiry: uint,
  closingPriceE18: uint,
  markA: uint,
  markB: uint,
  markC: uint,
  twap30mE18: uint,
  marksObservedAt: uint,
  closeObservedAt: uint,
  twapStart: uint,
  twapEnd: uint,
  halted: z.boolean(),
  fallbackMarkE18: uint,
  fallbackObservedAt: uint,
  nonce: uint,
});

export const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((v) => v as `0x${string}`);

/** JSON.stringify that writes bigints as decimal strings. */
export const toJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Plain-object form of a message, with bigints as strings, ready for JSON. */
export const wire = <T extends TradeQuoteMsg | OrderMsg | AttestationMsg | BellQuoteMsg | SeriesReferenceMsg | BellSettlementMsg>(msg: T): Record<string, unknown> =>
  JSON.parse(toJson(msg)) as Record<string, unknown>;
