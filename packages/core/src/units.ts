export const E18 = 10n ** 18n;
export const BPS = 10_000n;
/** USDG has 6 decimals; an E18 dollar amount divides by this to get USDG units. */
export const USDG_SCALE = 10n ** 12n;

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);
export const min = (...v: bigint[]): bigint => v.reduce((a, b) => (b < a ? b : a));
export const max = (...v: bigint[]): bigint => v.reduce((a, b) => (b > a ? b : a));
export const clamp0 = (x: bigint): bigint => (x < 0n ? 0n : x);

export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('mulDiv: division by zero');
  return (a * b) / d;
}

export const bpsOf = (amount: bigint, bps: bigint | number): bigint => (amount * BigInt(bps)) / BPS;

/** |value - ref| / ref in bps. A non-positive reference counts as infinitely far apart. */
export function diffBps(value: bigint, ref: bigint): bigint {
  if (ref <= 0n) return 10n ** 9n;
  return (abs(value - ref) * BPS) / ref;
}

export const usdgToE18 = (usdg: bigint): bigint => usdg * USDG_SCALE;
export const e18ToUsdg = (e18: bigint): bigint => e18 / USDG_SCALE;

/** Notional in USDG (6dp) of a size in token units (E18) at a price in USD (E18). */
export const notionalUsdg = (sizeE18: bigint, priceE18: bigint): bigint =>
  e18ToUsdg((abs(sizeE18) * priceE18) / E18);

/** Size in token units (E18) that a USDG notional buys at a price (E18). */
export const sizeFromNotionalE18 = (notionalUsdg_: bigint, priceE18: bigint): bigint =>
  mulDiv(usdgToE18(notionalUsdg_), E18, priceE18);

export function parseUnits(s: string, decimals: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) throw new RangeError(`invalid decimal: ${s}`);
  const frac = (m[3] ?? '').padEnd(decimals, '0').slice(0, decimals);
  const v = BigInt(m[2]! + frac);
  return m[1] === '-' ? -v : v;
}

export function formatUnits(v: bigint, decimals: number, dp = decimals): string {
  const neg = v < 0n;
  const a = abs(v);
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, '0').slice(0, dp);
  const out = dp > 0 ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${out}` : out;
}

export const parseE18 = (s: string): bigint => parseUnits(s, 18);
export const formatE18 = (v: bigint, dp = 6): string => formatUnits(v, 18, dp);
export const parseUsdg = (s: string): bigint => parseUnits(s, 6);
export const formatUsdg = (v: bigint, dp = 6): string => formatUnits(v, 6, dp);
