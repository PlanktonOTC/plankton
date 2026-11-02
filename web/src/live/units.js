// Numbers the site shows and sends. The API speaks bigints as decimal strings: USDG has 6 decimals, prices and token
// sizes have 18. Everything money-shaped is parsed and formatted here, with bigint maths, never floating point.

export const USDG_DECIMALS = 6;
export const E18 = 10n ** 18n;

/** BigInt from a decimal string, number or bigint. Anything else (including null) is 0n, so a half-loaded screen shows zero, not NaN. */
export function big(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
  return 0n;
}

/** Parses "12.5" to scaled units. Returns null for anything that is not a plain non-negative decimal within `decimals` places. */
export function parseUnits(text, decimals) {
  const s = String(text ?? '').trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export const parseUsdg = (text) => parseUnits(text, USDG_DECIMALS);
export const parseE18 = (text) => parseUnits(text, 18);

/** Scaled units to a plain decimal string with up to `dp` places (trailing zeros kept to exactly `dp`). Rounds toward zero. */
export function formatUnits(value, decimals, dp = decimals) {
  const v = big(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = (abs % scale).toString().padStart(decimals, '0');
  frac = frac.slice(0, dp);
  const out = dp > 0 ? `${whole}.${frac.padEnd(dp, '0')}` : `${whole}`;
  return neg && /[1-9]/.test(out) ? `-${out}` : out;
}

export const formatUsdg = (value, dp = 2) => formatUnits(value, USDG_DECIMALS, dp);
export const formatE18 = (value, dp = 4) => formatUnits(value, 18, dp);

/** Floating-point view for display only (never for amounts that are sent). */
export const usdgNum = (value) => Number(big(value)) / 1e6;
export const e18Num = (value) => Number(big(value)) / 1e18;

export const money = (value, digits = 2) =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const signed = (value, digits = 2) => `${value >= 0 ? '+' : '−'}${money(Math.abs(value), digits)}`;
export const compact = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : money(value, 0));
export const shortAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '');

/** Price precision that reads well for the price level: small prices show more places. */
export const priceDigits = (price) => (price >= 100 ? 2 : price >= 1 ? 3 : 4);

/** Percent change from `then` to `now`; 0 when there is no reference. */
export const percentChange = (now, then) => (then > 0 ? ((now - then) / then) * 100 : 0);
