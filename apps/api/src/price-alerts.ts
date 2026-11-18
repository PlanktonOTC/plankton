import { formatUnits, parseUnits } from 'viem';

/** Most alerts one chat may hold at a time. */
export const MAX_ALERTS_PER_CHAT = 20;

export type AlertRequest = { symbol: string; above: boolean; priceE18: bigint };

/**
 * Parses the arguments of `/alert SYMBOL > PRICE` (also `<`, `above`, `below`, a `$` before the price, or the
 * operator joined to the price: `>9.5`). Returns a reason string when the request cannot be used.
 */
export function parseAlert(args: string[], symbols: string[]): AlertRequest | string {
  const usage = 'Usage: /alert SYMBOL > PRICE  (or <). Example: /alert WYFI > 9.50';
  const text = args.join(' ').trim();
  const m = /^([A-Za-z.]+)\s*(>=?|<=?|above|below)\s*\$?\s*([0-9]*\.?[0-9]+)$/i.exec(text);
  if (!m) return usage;
  const symbol = m[1]!.toUpperCase();
  if (!symbols.includes(symbol)) return 'Unknown market symbol. Use /prices to see listings.';
  const op = m[2]!.toLowerCase();
  const above = op.startsWith('>') || op === 'above';
  const [whole, frac = ''] = m[3]!.split('.');
  if (frac.length > 6) return 'Use at most 6 decimal places for the price.';
  const priceE18 = parseUnits(`${whole || '0'}.${frac || '0'}`, 18);
  if (priceE18 <= 0n) return 'The price must be above 0.';
  return { symbol, above, priceE18 };
}

/** Whether a live price meets the alert's condition (at or beyond the level). */
export const alertHit = (above: boolean, targetE18: bigint, priceE18: bigint) => (above ? priceE18 >= targetE18 : priceE18 <= targetE18);

export const usd = (e18: bigint | string) =>
  `$${Number(formatUnits(BigInt(e18), 18)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

export const describeAlert = (a: { symbol: string; above: boolean; priceE18: bigint | string }) => `${a.symbol} ${a.above ? 'above' : 'below'} ${usd(a.priceE18)}`;
