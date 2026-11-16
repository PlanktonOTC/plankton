// Default take-profit / stop-loss levels, as a percent move in the price from the entry. They are filled into the ticket and the
// protection dialog automatically, and the trader can edit every value. Saved in this browser only: nothing is sent anywhere.

export const PRESET_KEY = 'plankton.tpsl.presets.v1';
export const DEFAULT_PRESETS = Object.freeze({ auto: true, tpPct: 10, slPct: 5 });
export const LIMITS = Object.freeze({ tpPct: [0.5, 200], slPct: [0.5, 90] });

const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : fallback);

/** Any stored or typed value to a safe preset: percentages inside their limits, a boolean flag. */
export function sanitizePresets(input) {
  const p = input && typeof input === 'object' ? input : {};
  return {
    auto: typeof p.auto === 'boolean' ? p.auto : DEFAULT_PRESETS.auto,
    tpPct: Math.round(clamp(num(p.tpPct, DEFAULT_PRESETS.tpPct), LIMITS.tpPct) * 100) / 100,
    slPct: Math.round(clamp(num(p.slPct, DEFAULT_PRESETS.slPct), LIMITS.slPct) * 100) / 100,
  };
}

/** Read the saved presets. Falls back to the defaults when storage is empty, blocked or corrupt (private windows, cleared data). */
export function loadPresets(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PRESET_KEY);
    return raw ? sanitizePresets(JSON.parse(raw)) : { ...DEFAULT_PRESETS };
  } catch {
    return { ...DEFAULT_PRESETS };
  }
}

export function savePresets(presets, storage = globalThis.localStorage) {
  try {
    storage?.setItem(PRESET_KEY, JSON.stringify(sanitizePresets(presets)));
    return true;
  } catch {
    return false; // the presets still work for this visit
  }
}

/**
 * The take-profit and stop-loss prices for a position on `side` entered near `reference`, as strings with `digits` decimals.
 * A long profits when the price rises, a short when it falls; the stop-loss is the opposite direction.
 */
export function presetLevels(side, reference, presets, digits = 4) {
  const ref = Number(reference);
  if (!(ref > 0)) return { tp: '', sl: '' };
  const p = sanitizePresets(presets);
  const up = side === 'long' ? 1 : -1;
  const fmt = (v) => (v > 0 ? v.toFixed(digits) : '');
  return { tp: fmt(ref * (1 + (up * p.tpPct) / 100)), sl: fmt(ref * (1 - (up * p.slPct) / 100)) };
}

/** What a price-move percentage means for the margin at a given leverage (a 5% move at 2x is 10% of the margin). */
export const marginPercent = (pricePct, leverage) => Math.round(pricePct * (Number(leverage) || 1) * 10) / 10;
