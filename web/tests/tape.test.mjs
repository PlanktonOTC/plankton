import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTranslator } from '../src/i18n/core.js';
import zh from '../src/locales/zh-CN.js';
import {
  EARNINGS_TIMING,
  FILING_HINTS,
  FILING_TAGS,
  HALT_STATES,
  SCANNER_COLUMNS,
  SCANNER_TAGS,
  TAPE_TABS,
  calendarDay,
  contextEvents,
  daysUntil,
  earningsCalendar,
  easternTime,
  eps,
  haltDuration,
  pct,
  shares,
  sortScanner,
  tapeTabFrom,
  times,
  visibleFilings,
  visibleHalts,
} from '../src/live/tape.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0);

test('a link can open a Tape tab; anything else opens Conditions', () => {
  assert.equal(tapeTabFrom('?view=tape&tape=scanner'), 'Scanner');
  assert.equal(tapeTabFrom('?tape=FILINGS'), 'Filings');
  assert.equal(tapeTabFrom('?tape=nope'), 'Conditions');
  assert.equal(tapeTabFrom(''), 'Conditions');
});

test('numbers read cleanly, and missing ones show a dash', () => {
  assert.equal(pct(12.345), '+12.3%');
  assert.equal(pct(-7.24), '−7.2%');
  assert.equal(pct(0.01), '0.0%');
  assert.equal(pct(null), '—');
  assert.equal(pct(Number.NaN), '—');
  assert.equal(times(1.637), '1.64×');
  assert.equal(shares(139_542_570), '139.5M');
  assert.equal(shares(2_400_000_000), '2.40B');
  assert.equal(shares(950_400), '950K');
  assert.equal(shares(null), '—');
  assert.equal(eps(-0.59), '−$0.59');
  assert.equal(eps(0.2), '$0.20');
  assert.equal(eps(null), '—');
});

const row = (symbol, over = {}) => ({ symbol, changePct: null, gapPct: null, extended: null, relativeVolume: null, floatTurnoverPct: null, fromHigh52Pct: null, tags: [], ...over });
const rows = [row('A', { changePct: 4, gapPct: -9 }), row('B', { changePct: -12, extended: { changePct: 31 } }), row('C'), row('D', { changePct: 8, relativeVolume: 3 })];

test('the scanner ranks the biggest move either way first, and missing values always last', () => {
  assert.deepEqual(sortScanner(rows, 'changePct', 'abs').map((r) => r.symbol), ['B', 'D', 'A', 'C']);
  assert.deepEqual(sortScanner(rows, 'changePct', 'desc').map((r) => r.symbol), ['D', 'A', 'B', 'C']);
  assert.deepEqual(sortScanner(rows, 'changePct', 'asc').map((r) => r.symbol), ['B', 'A', 'D', 'C']);
  assert.deepEqual(sortScanner(rows, 'extended', 'abs').map((r) => r.symbol), ['B', 'A', 'C', 'D']);
  assert.deepEqual(sortScanner(rows, 'relativeVolume', 'desc').map((r) => r.symbol), ['D', 'A', 'B', 'C']);
  assert.deepEqual(sortScanner(rows, 'symbol', 'asc').map((r) => r.symbol), ['A', 'B', 'C', 'D']);
  assert.deepEqual(sortScanner(undefined), []);
});

test('halts filter by ours and by still in force, and durations read naturally', () => {
  const halts = [{ symbol: 'A', listed: true, state: 'resumed' }, { symbol: 'B', listed: false, state: 'halted' }, { symbol: 'C', listed: true, state: 'resuming' }];
  assert.deepEqual(visibleHalts(halts, { listedOnly: true }).map((h) => h.symbol), ['A', 'C']);
  assert.deepEqual(visibleHalts(halts, { activeOnly: true }).map((h) => h.symbol), ['B', 'C']);
  assert.equal(haltDuration({ startedAt: NOW - 5 * 60_000, resumesAt: NOW - 60_000 }, NOW), '4m');
  assert.equal(haltDuration({ startedAt: NOW - 125 * 60_000, resumesAt: null }, NOW), '2h 5m');
  assert.equal(haltDuration({ startedAt: NOW - 3 * 86_400_000, resumesAt: NOW + 60_000 }, NOW), '3d'); // still running until it resumes
});

test('times are shown in New York time; calendar days do not shift with the viewer’s zone', () => {
  assert.equal(easternTime(Date.UTC(2026, 10, 17, 0, 50)), 'Nov 16, 7:50 PM ET');
  assert.equal(easternTime('nonsense'), '—');
  assert.equal(calendarDay('2027-03-17'), 'Wed, Mar 17, 2027');
  assert.equal(calendarDay(null), '—');
  assert.equal(daysUntil('2026-11-17', NOW), 0);
  assert.equal(daysUntil('2026-11-23', NOW), 6);
  assert.equal(daysUntil('2026-11-16', NOW), -1);
});

const filings = [
  { symbol: 'TE', form: '424B5', acceptedAt: '2026-11-16T11:53:13.000Z', importance: 'high', tags: ['offering'], url: 'https://www.sec.gov/te' },
  { symbol: 'TE', form: 'S-3', acceptedAt: '2026-11-15T11:53:13.000Z', importance: 'high', tags: ['shelf'], url: 'https://www.sec.gov/te2' },
  { symbol: 'RCAT', form: '8-K', acceptedAt: '2026-11-16T21:06:25.000Z', importance: 'medium', tags: ['earnings'], url: 'https://www.sec.gov/rcat' },
  { symbol: 'RUN', form: '8-K', acceptedAt: '2026-10-01T21:48:00.000Z', importance: 'high', tags: ['charter_change'], url: 'https://www.sec.gov/run' },
  { symbol: 'DJT', form: '4', acceptedAt: '2026-11-16T21:00:00.000Z', importance: 'low', tags: ['insider_trade'], url: 'https://www.sec.gov/djt' },
];
const earnings = [
  { symbol: 'FLNC', next: { date: '2026-11-23', timing: 'pm', verified: true, quarter: 4, year: 2026, epsEstimate: -0.59 }, last: null },
  { symbol: 'NNE', next: { date: '2026-11-30', timing: 'pm', verified: true, quarter: 4, year: 2026, epsEstimate: -0.29 }, last: null },
  { symbol: 'CLSK', next: { date: '2026-11-18', timing: null, verified: false, quarter: 4, year: 2026, epsEstimate: -0.37 }, last: null },
  { symbol: 'DJT', next: null, last: null },
];

test('filings filter by company and by flag', () => {
  assert.deepEqual(visibleFilings(filings, { flaggedOnly: true }).map((f) => f.symbol), ['TE', 'TE', 'RCAT', 'RUN']);
  assert.deepEqual(visibleFilings(filings, { symbol: 'DJT' }).map((f) => f.form), ['4']);
});

test('the earnings calendar is soonest first and leaves out companies with no date', () => {
  const cal = earningsCalendar(earnings, NOW);
  assert.deepEqual(cal.map((e) => [e.symbol, e.days]), [['CLSK', 1], ['FLNC', 6], ['NNE', 13]]);
});

test('Conditions gets one card per market for its newest serious filing, and one for earnings this week', () => {
  const events = contextEvents({ filings, earnings, now: NOW });
  assert.deepEqual(events.map((e) => [e.symbol, e.type, e.title]), [
    ['TE', 'Filing', 'Offering'],
    ['CLSK', 'Earnings', 'Earnings tomorrow'],
    ['FLNC', 'Earnings', 'Earnings in {days} days'],
  ]);
  assert.equal(events[0].link, 'https://www.sec.gov/te');
  assert.equal(events[0].form, '424B5');
  assert.deepEqual(events[2].vars, { days: 6 });
  assert.equal(events[1].body, 'Release time not stated');
  assert.equal(events[1].note, 'Date not yet confirmed by the company.');
  assert.equal(events[2].note, null);
});

test('every label the Tape shows has a Chinese entry', () => {
  const t = makeTranslator(zh);
  const missing = [];
  const check = (text, context) => {
    const key = context ? `${text}|${context}` : text;
    if (!Object.prototype.hasOwnProperty.call(zh, key) && t(text, null, context) === text) missing.push(key);
  };
  for (const tab of [...TAPE_TABS, 'Filing', 'Earnings']) check(tab, 'tape');
  for (const c of SCANNER_COLUMNS) check(c.label, c.key === 'extended' ? 'scanner' : undefined);
  for (const list of [SCANNER_TAGS, FILING_TAGS, FILING_HINTS, HALT_STATES, EARNINGS_TIMING]) for (const label of Object.values(list)) check(label);
  for (const s of ['Earnings today', 'Earnings tomorrow', 'Release time not stated', 'Date not yet confirmed by the company.', 'Company update', 'A company filing with the SEC.']) check(s);
  assert.deepEqual(missing, []);
  assert.equal(t('Earnings in {days} days', { days: 6 }), '6 天后发布财报');
});
