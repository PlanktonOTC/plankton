import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compilePatterns, format, makeTranslator, normalizeLang, placeholders, prefersChinese, resolveLang } from '../src/i18n/core.js';
import zh, { site } from '../src/locales/zh-CN.js';

test('language names are understood', () => {
  assert.equal(normalizeLang('zh'), 'zh-CN');
  assert.equal(normalizeLang('ZH-cn'), 'zh-CN');
  assert.equal(normalizeLang('zh_Hans'), 'zh-CN');
  assert.equal(normalizeLang('cn'), 'zh-CN');
  assert.equal(normalizeLang('en-GB'), 'en');
  assert.equal(normalizeLang('fr'), null);
  assert.equal(normalizeLang(''), null);
  assert.equal(normalizeLang(null), null);
});

test('the link wins over the saved choice, which wins over the default', () => {
  assert.equal(resolveLang({ search: '?lang=zh', stored: 'en' }), 'zh-CN');
  assert.equal(resolveLang({ search: '?lang=en', stored: 'zh-CN' }), 'en');
  assert.equal(resolveLang({ search: '', stored: 'zh-CN' }), 'zh-CN');
  assert.equal(resolveLang({ search: '?x=1', stored: null }), 'en');
  assert.equal(resolveLang({ search: '?lang=klingon', stored: 'zh-CN' }), 'zh-CN');
  assert.equal(resolveLang({}), 'en');
});

test('Chinese browsers are detected but never switched automatically', () => {
  assert.equal(prefersChinese(['en-US', 'zh-CN']), true);
  assert.equal(prefersChinese(['zh-Hant-TW']), true);
  assert.equal(prefersChinese(['en-US', 'fr']), false);
  assert.equal(prefersChinese([]), false);
});

test('format fills markers and leaves unknown ones visible', () => {
  assert.equal(format('{n} days ago', { n: 3 }), '3 days ago');
  assert.equal(format('{a} and {b}', { a: 1 }), '1 and {b}');
  assert.equal(format('no markers', { a: 1 }), 'no markers');
  assert.deepEqual(placeholders('{n} of {total} for {n}'), ['n', 'n', 'total']);
});

test('the translator uses the dictionary, and falls back to English for anything it does not have', () => {
  const missing = [];
  const t = makeTranslator({ 'Open terminal': '打开终端', '{n} days ago': '{n} 天前' }, (s) => missing.push(s));
  assert.equal(t('Open terminal'), '打开终端');
  assert.equal(t('{n} days ago', { n: 4 }), '4 天前');
  assert.equal(t('Brand new sentence'), 'Brand new sentence');
  assert.equal(t('Brand new sentence {x}', { x: 1 }), 'Brand new sentence 1');
  assert.deepEqual(missing, ['Brand new sentence', 'Brand new sentence {x}']);
  const english = makeTranslator(null);
  assert.equal(english('Open terminal'), 'Open terminal');
  assert.equal(english('{n}s ago', { n: 9 }), '9s ago');
  // dictionary keys named like Object.prototype members must not leak
  assert.equal(makeTranslator({})('constructor'), 'constructor');
});

test('every Chinese entry keeps the same {placeholders} as its English', () => {
  for (const [en, cn] of Object.entries(zh)) {
    assert.deepEqual(placeholders(cn), placeholders(en), `placeholders differ for: ${en}`);
  }
});

test('no Chinese entry is empty, identical-by-accident, or a leftover English sentence', () => {
  for (const [en, cn] of Object.entries(zh)) {
    assert.ok(typeof cn === 'string' && cn.trim().length > 0, `empty translation: ${en}`);
    if (/[a-z]{4,} [a-z]{3,} [a-z]{3,}/i.test(en) && en.length > 40) {
      assert.ok(/[一-鿿]/.test(cn), `long sentence without Chinese characters: ${en}`);
    }
  }
});

test('the dictionary has no entries whose English no longer appears anywhere in the source (stale)', () => {
  // The English text is looked up exactly, so an entry whose English was edited out of the code is dead weight and should be removed.
  const files = ['src/App.jsx', 'src/Visuals.jsx', 'src/Feed.jsx', 'src/data/product.js'].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
  const source = files.join('\n').replace(/\\'/g, "'");
  // strings the code builds at run time (Feed ages, error wrappers, market states, "Week NN" labels)
  const dynamic = new Set(['{n} days ago', '{n}s ago', '{n} min ago', '{n} h ago', 'never', 'halted', 'weekend', 'unset', 'frozen', 'extended', 'open', 'tier', 'history',
    'Showing the last good data. {error}.', '{error}. Try again in a moment.', 'Language']);
  const stale = Object.keys(site).filter((en) => {
    if (dynamic.has(en) || /^Week \d\d$/.test(en)) return false;
    const needle = en.length > 60 ? en.slice(0, 60) : en;
    return !source.includes(needle) && !source.includes(needle.replace(/’/g, "'"));
  });
  assert.deepEqual(stale, [], `entries with no matching English in the source:\n${stale.join('\n')}`);
});

test('only the Chinese dictionary files exist besides English (adding a language means adding files here)', () => {
  assert.deepEqual(readdirSync(new URL('../src/locales/', import.meta.url)).sort(), ['zh-CN-docs.js', 'zh-CN-terminal.js', 'zh-CN.js']);
});

test('patterns: runtime sentences built by the logic modules are translated with their values', () => {
  const t = makeTranslator(zh);
  assert.equal(t('Your wallet holds 12.50 USDG.'), '你的钱包持有 12.50 USDG。');
  assert.equal(t('Close or trim your long position before opening a short.'), '开 空头 之前，请先平掉或减少你的多头仓位。');
  assert.equal(t('in 5m'), '5 分钟后');
  assert.equal(t('3h ago'), '3 小时前');
  assert.equal(t('Oldest request waiting 4h'), '最早的请求已等待 4 小时');
  assert.equal(t('Deposited 5.00 USDG.'), '已存入 5.00 USDG。');
  assert.equal(t('RCAT long opened.'), 'RCAT 多头已开仓。');
  // a sentence nobody translated stays English rather than being mangled by a loose pattern
  assert.equal(t('A sentence that is not in the dictionary at all.'), 'A sentence that is not in the dictionary at all.');
});

test('contexts: one English word, two meanings', () => {
  const t = makeTranslator(zh);
  assert.equal(t('Market'), '市场');
  assert.equal(t('Market', null, 'order type'), '市价');
  assert.equal(t('Limit', null, 'tape'), '限制');
  assert.equal(t('Limit', null, 'order type'), '限价');
});

test('every plain tr(...) / t(...) sentence in the terminal source has a Chinese entry', () => {
  const files = ['src/Docs.jsx', 'src/Dashboard.jsx', 'src/terminal/Chart.jsx', 'src/terminal/Dialogs.jsx', 'src/terminal/Positions.jsx', 'src/terminal/Presets.jsx', 'src/terminal/Risk.jsx', 'src/terminal/Ticket.jsx', 'src/terminal/Views.jsx', 'src/terminal/Tape.jsx', 'src/terminal/shared.jsx'];
  const patterns = compilePatterns(zh);
  const covered = (text) => Object.prototype.hasOwnProperty.call(zh, text) || patterns.some((p) => p.regex.test(text));
  const call = /\btr\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;
  const uncovered = [];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const m of source.matchAll(call)) {
      const text = (m[1] ?? m[2]).replace(/\\'/g, "'");
      if (!covered(text)) uncovered.push(`${file}: ${text}`);
    }
  }
  assert.deepEqual(uncovered, [], `English sentences with no Chinese entry:\n${uncovered.join('\n')}`);
});
