// Writes contracts/test/vectors.json: inputs and outputs of the TypeScript money math, so a Solidity test can check
// that the contracts compute exactly the same numbers. If the two ever drift, quotes the backend signs would be
// rejected on-chain, or worse, accepted at the wrong price.   Run: bun run vectors
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E18, closeSizeDeltaE18, notionalUsdg, skewFillPriceE18, skewScaleE18, tradeFeeUsdg, unrealizedPnlUsdg } from '@plankton/core';

const s = (v: bigint) => v.toString();
const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // n with 6 decimals of precision, in E18
const usdg = (n: number) => BigInt(Math.round(n * 1e6));

const marks = [e18(1), e18(7.77), e18(100), e18(344.9076), e18(12_345.678)];
const caps = [usdg(2_000), usdg(4_000), usdg(10_000), usdg(50_000)];
const skews = [e18(-5_000), e18(-1_234.5), 0n, e18(333), e18(4_000)];

const skewFill = [];
for (const mark of marks) {
  for (const cap of caps) {
    const scale = skewScaleE18(cap);
    for (const before of skews) {
      for (const after of [before + e18(250), before - e18(480.25), before + e18(1_000)]) {
        skewFill.push({ mark: s(mark), before: s(before), after: s(after), scale: s(scale), expected: s(skewFillPriceE18(mark, before, after, scale)) });
      }
    }
  }
}

const notional = [];
for (const size of [1n, 123_456_789n, 10n ** 17n, 5n * E18, 37_500_000_000_000_000_000n]) {
  for (const price of marks) notional.push({ size: s(size), price: s(price), expected: s(notionalUsdg(size, price)) });
}

const pnl = [];
for (const size of [10n ** 17n, 5n * E18, 37_500_000_000_000_000_000n]) {
  for (const entry of [e18(100), e18(344.9076)]) {
    for (const price of [e18(61.5), e18(100), e18(101.337), e18(344.9076), e18(500)]) {
      for (const long of [true, false]) {
        const signed = long ? size : -size;
        pnl.push({ long, size: s(size), entry: s(entry), price: s(price), expected: s(unrealizedPnlUsdg({ sizeE18: signed, entryE18: entry, marginUsdg: 0n }, price)) });
      }
    }
  }
}

const fractionClose = [];
for (const size of [5n * E18, -5n * E18, 7n, -123_456_789_012_345_678n]) {
  for (const bps of [1, 100, 2_500, 3_333, 9_999, 10_000]) fractionClose.push({ size: s(size), bps, expected: s(closeSizeDeltaE18(size, bps)) });
}

const fee = [];
for (const n of [1n, 999_999n, 500_000_000n, 123_456_789_012n]) for (const bps of [8, 12, 100]) fee.push({ notional: s(n), bps, expected: s(tradeFeeUsdg(n, bps)) });

const skewScale = caps.map((cap) => ({ cap: s(cap), expected: s(skewScaleE18(cap)) }));

const out = resolve(import.meta.dir, '../contracts/test/vectors.json');
writeFileSync(out, JSON.stringify({ skewFill, notional, pnl, fractionClose, fee, skewScale }, null, 1));
console.log(`wrote ${out}: ${skewFill.length} skew, ${notional.length} notional, ${pnl.length} pnl, ${fractionClose.length} close, ${fee.length} fee`);
