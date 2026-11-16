import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESETS, PRESET_KEY, loadPresets, marginPercent, presetLevels, sanitizePresets, savePresets } from '../src/live/presets.js';
import { protectionProblem } from '../src/live/orders.js';

const memory = () => {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => void data.set(k, String(v)), data };
};

test('defaults are on, with take-profit 10% and stop-loss 5%', () => {
  assert.deepEqual({ ...DEFAULT_PRESETS }, { auto: true, tpPct: 10, slPct: 5 });
});

test('a long: take-profit above, stop-loss below the entry', () => {
  assert.deepEqual(presetLevels('long', 4, DEFAULT_PRESETS, 3), { tp: '4.400', sl: '3.800' });
});

test('a short: take-profit below, stop-loss above the entry', () => {
  assert.deepEqual(presetLevels('short', 4, DEFAULT_PRESETS, 3), { tp: '3.600', sl: '4.200' });
});

test('levels always pass the same check the ticket and dialog use', () => {
  for (const side of ['long', 'short']) {
    for (const ref of [0.5, 3.445, 21.4, 150]) {
      for (const p of [DEFAULT_PRESETS, { auto: true, tpPct: 0.5, slPct: 0.5 }, { auto: true, tpPct: 200, slPct: 90 }]) {
        const { tp, sl } = presetLevels(side, ref, p, 4);
        assert.equal(protectionProblem(side, ref, tp, sl), null, `${side} ${ref} ${JSON.stringify(p)}`);
      }
    }
  }
});

test('no price yet means no levels', () => {
  assert.deepEqual(presetLevels('long', 0, DEFAULT_PRESETS), { tp: '', sl: '' });
  assert.deepEqual(presetLevels('long', NaN, DEFAULT_PRESETS), { tp: '', sl: '' });
});

test('sanitizing keeps values inside their limits and fixes junk', () => {
  assert.deepEqual(sanitizePresets({ auto: false, tpPct: 9999, slPct: 0 }), { auto: false, tpPct: 200, slPct: 0.5 });
  assert.deepEqual(sanitizePresets({ tpPct: 'abc', slPct: '' }), { auto: true, tpPct: 10, slPct: 5 });
  assert.deepEqual(sanitizePresets(null), { auto: true, tpPct: 10, slPct: 5 });
  assert.deepEqual(sanitizePresets({ tpPct: '12.345', slPct: '2.5' }), { auto: true, tpPct: 12.35, slPct: 2.5 });
});

test('save then load round-trips', () => {
  const s = memory();
  assert.equal(savePresets({ auto: false, tpPct: 15, slPct: 3 }, s), true);
  assert.deepEqual(loadPresets(s), { auto: false, tpPct: 15, slPct: 3 });
});

test('empty, corrupt or blocked storage falls back to the defaults', () => {
  assert.deepEqual(loadPresets(memory()), { ...DEFAULT_PRESETS });
  const bad = memory();
  bad.setItem(PRESET_KEY, '{not json');
  assert.deepEqual(loadPresets(bad), { ...DEFAULT_PRESETS });
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadPresets(blocked), { ...DEFAULT_PRESETS });
  assert.equal(savePresets(DEFAULT_PRESETS, blocked), false);
  assert.deepEqual(loadPresets(undefined), { ...DEFAULT_PRESETS });
});

test('margin percent scales with leverage', () => {
  assert.equal(marginPercent(5, 2), 10);
  assert.equal(marginPercent(10, 3), 30);
  assert.equal(marginPercent(5, 0), 5);
});
