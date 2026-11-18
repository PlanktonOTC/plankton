import { describe, expect, test } from 'bun:test';
import { buildCalendar, type CalendarDay } from '@plankton/core';
import { marketEvents, wantsEvent } from '../src/market-events.ts';

const day = (d: string): CalendarDay => ({ day: d, holiday: false, earlyClose: false, openEt: '09:30', closeEt: '16:00' });
// Thursday 2026-11-19 and Friday 2026-11-20 (EST: 16:00 ET is 21:00Z).
const calendar = buildCalendar([day('2026-11-19'), day('2026-11-20')]);
const at = (iso: string) => Date.parse(iso);
const base = { halts: [], earnings: [], corporateActions: [], calendar, windowTz: 'Europe/Berlin' };
const halt = (over: object) => ({ symbol: 'WYFI', startedAt: at('2026-11-19T15:00:00Z'), resumesAt: null, reason: 'News pending', reasonCode: 'T1', state: 'halted', listed: true, ...over });

describe('market events', () => {
  test('a fresh halt on a listed market is news; an old or unlisted one is not', () => {
    const now = at('2026-11-19T15:10:00Z');
    const ev = marketEvents({ ...base, nowMs: now, halts: [halt({}), halt({ symbol: 'AAPL', listed: false }), halt({ symbol: 'RCAT', startedAt: at('2026-11-19T13:00:00Z') })] });
    expect(ev.map((e) => e.id)).toEqual([`halt:WYFI:${at('2026-11-19T15:00:00Z')}:T1`]);
    expect(ev[0]!.text).toContain('WYFI is halted on Nasdaq (News pending)');
    expect(ev[0]!.symbol).toBe('WYFI');
  });

  test('a published resumption is announced around its time', () => {
    const resumes = at('2026-11-19T15:30:00Z');
    const before = marketEvents({ ...base, nowMs: at('2026-11-19T15:20:00Z'), halts: [halt({ resumesAt: resumes, state: 'resuming' })] });
    expect(before.find((e) => e.id.startsWith('resume:'))!.text).toMatch(/resumes trading at 10:30 AM ET/);
    const after = marketEvents({ ...base, nowMs: at('2026-11-19T15:35:00Z'), halts: [halt({ resumesAt: resumes, state: 'resumed' })] });
    expect(after.find((e) => e.id.startsWith('resume:'))!.text).toContain('has resumed trading');
    expect(marketEvents({ ...base, nowMs: at('2026-11-19T18:00:00Z'), halts: [halt({ resumesAt: resumes, state: 'resumed' })] })).toEqual([]);
  });

  test('a pending split is announced; finished actions and dividends are not', () => {
    const ev = marketEvents({
      ...base,
      nowMs: at('2026-11-19T15:00:00Z'),
      corporateActions: [
        { symbol: 'RCAT', id: 'a1', type: 'reverse_split', status: 'scheduled', processDate: '2026-11-24' },
        { symbol: 'RCAT', id: 'a2', type: 'reverse_split', status: 'completed', processDate: '2026-10-01' },
        { symbol: 'TE', id: 'a3', type: 'cash_dividend', status: 'scheduled', processDate: null },
      ],
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ id: 'split:a1', symbol: 'RCAT' });
    expect(ev[0]!.text).toContain('RCAT has a reverse split pending (Tue, Nov 24)');
  });

  test('earnings are announced the day before and the day of, not earlier', () => {
    const now = at('2026-11-19T15:00:00Z');
    const ev = marketEvents({
      ...base,
      nowMs: now,
      earnings: [
        { symbol: 'QUBT', next: { date: '2026-11-20', timing: 'pm' } },
        { symbol: 'DJT', next: { date: '2026-11-19', timing: 'am' } },
        { symbol: 'SLS', next: { date: '2026-11-25', timing: null } },
        { symbol: 'NNE', next: null },
      ],
    });
    expect(ev.map((e) => e.id).sort()).toEqual(['earnings:DJT:2026-11-19', 'earnings:QUBT:2026-11-20']);
    expect(ev.find((e) => e.symbol === 'QUBT')!.text).toContain('QUBT reports earnings tomorrow after the close (Fri, Nov 20)');
    expect(ev.find((e) => e.symbol === 'DJT')!.text).toContain('today before the open');
  });

  test('the close-only notice goes out in the 15 minutes before a Friday close, for every market', () => {
    const friday = (iso: string) => marketEvents({ ...base, nowMs: at(iso) }).filter((e) => e.id.startsWith('close-only'));
    expect(friday('2026-11-20T20:40:00Z')).toEqual([]); // 15:40 ET: too early
    const ev = friday('2026-11-20T20:46:00Z'); // 15:46 ET
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ id: 'close-only:2026-11-20', symbol: null });
    expect(ev[0]!.text).toContain('until the weekend hold begins');
    expect(friday('2026-11-20T21:05:00Z')).toEqual([]); // already close-only: the notice is for before
    expect(friday('2026-11-19T20:50:00Z')).toEqual([]); // an ordinary Thursday close
  });

  test('on the eve of a holiday the notice names the holiday hold', () => {
    const cal = buildCalendar([day('2026-11-25'), { ...day('2026-11-26'), holiday: true }]);
    const ev = marketEvents({ ...base, calendar: cal, nowMs: at('2026-11-25T20:50:00Z') }).filter((e) => e.id.startsWith('close-only'));
    expect(ev[0]!.text).toContain('until the holiday hold begins');
  });

  test('a chat gets market-wide notices always, and per-market ones for its markets', () => {
    const wyfi = { id: 'x', symbol: 'WYFI', text: '' };
    const all = { id: 'y', symbol: null, text: '' };
    expect(wantsEvent(null, wyfi)).toBe(true);
    expect(wantsEvent(['WYFI'], wyfi)).toBe(true);
    expect(wantsEvent(['RCAT'], wyfi)).toBe(false);
    expect(wantsEvent(['RCAT'], all)).toBe(true);
  });
});
