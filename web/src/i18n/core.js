// Translation core, with no React in it so it can be tested directly.
//
// How it works: the English text IS the key. Code writes t('Open terminal') and the Chinese dictionary maps that exact English
// sentence to its translation. If the English is edited later, the old dictionary entry stops matching and the page simply shows
// the new English, so a stale translation can never be shown next to changed English. A missing entry also shows English.

export const SUPPORTED = ['en', 'zh-CN'];
export const STORAGE_KEY = 'plankton.lang';

/** Any language label (a URL value, a saved value, a browser code) to a supported language, or null. */
export function normalizeLang(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase().replace('_', '-');
  if (s === 'en' || s.startsWith('en-')) return 'en';
  if (['zh', 'cn', 'zh-cn', 'zh-hans', 'zh-sg', 'zh-hans-cn', 'chinese'].includes(s)) return 'zh-CN';
  return null;
}

/** The language to start in: ?lang= in the link wins (so shared links work), then the saved choice, then English. */
export function resolveLang({ search = '', stored = null } = {}) {
  let query = null;
  try {
    query = new URLSearchParams(search).get('lang');
  } catch {
    /* a malformed query string is ignored */
  }
  return normalizeLang(query) ?? normalizeLang(stored) ?? 'en';
}

/** Whether the browser says its user reads Chinese: used only to offer the switch, never to force it. */
export const prefersChinese = (languages = []) => languages.some((l) => /^zh(\b|-)/i.test(String(l)));

/** Replaces {name} markers. A marker with no value is left as written, so a mistake is visible, not blank. */
export function format(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match));
}

export const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const SHORT_PATTERN = 12;
const has = (dict, key) => Object.prototype.hasOwnProperty.call(dict, key);

/**
 * Entries whose English has {markers} double as patterns. The terminal builds some English sentences at run time
 * ("Your wallet holds 12.50 USDG."), and the logic that builds them stays untouched: the sentence is matched against the pattern
 * 'Your wallet holds {amount} USDG.' and the captured pieces are put into the Chinese. A captured piece that is itself a
 * dictionary entry (for example the word "long") is translated too.
 */
export function compilePatterns(dict) {
  const patterns = [];
  for (const key of Object.keys(dict)) {
    const names = [];
    const parts = key.split(/\{(\w+)\}/);
    if (parts.length < 3) continue; // no markers
    let source = '';
    parts.forEach((part, i) => {
      if (i % 2 === 0) source += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else { names.push(part); source += '([\\s\\S]+?)'; }
    });
    patterns.push({ key, names, regex: new RegExp(`^${source}$`), literal: parts.filter((_, i) => i % 2 === 0).join('').length });
  }
  return patterns.sort((a, b) => b.literal - a.literal); // the most specific pattern first
}

/**
 * Builds t(text, vars, context) for a dictionary (null means English). The English text is the key. When one English word needs two
 * different translations ("Market" as a table heading and as an order type), the second use passes a context and the dictionary
 * holds it as 'Market|order type'. Without a context entry the plain one is used.
 */
export function makeTranslator(dict, onMissing) {
  const cache = new Map();
  let patterns = null;
  const lookup = (text) => {
    if (has(dict, text)) return dict[text];
    if (cache.has(text)) return cache.get(text);
    patterns ??= compilePatterns(dict);
    let out;
    for (const p of patterns) {
      const m = p.regex.exec(text);
      if (!m) continue;
      // A pattern with little fixed text ('{symbol} is {dir} {price}') could otherwise swallow any sentence: its values must be single words.
      if (p.literal < SHORT_PATTERN && m.slice(1).some((v) => /\s/.test(v))) continue;
      const vars = {};
      p.names.forEach((name, i) => { vars[name] = has(dict, m[i + 1]) && !/\{\w+\}/.test(dict[m[i + 1]]) ? dict[m[i + 1]] : m[i + 1]; });
      out = format(dict[p.key], vars);
      break;
    }
    cache.set(text, out);
    return out;
  };
  return (text, vars, context) => {
    let out = text;
    if (dict && typeof text === 'string') {
      const found = context && has(dict, `${text}|${context}`) ? dict[`${text}|${context}`] : lookup(text);
      if (found !== undefined) out = found;
      else if (onMissing) onMissing(text);
    }
    return vars ? format(out, vars) : out;
  };
}
