import { describe, expect, test } from 'bun:test';
import { DEFAULT_PROFILES, Status, buildCalendar, calendarHorizonDays, sessionAt, zonedTimeToUtc, type CalendarDay } from '../src/index.ts';

const day = (d: string, over: Partial<CalendarDay> = {}): CalendarDay => ({
  day: d,
  holiday: false,
  earlyClose: false,
  openEt: '09:30',
  closeEt: '16:00',
  ...over,
});

// A calendar around the 2026-11-01 US clock change (EDT -> EST) and Thanksgiving week.
const cal = buildCalendar([
  day('2026-10-30'),
  day('2026-11-02'),
  day('2026-11-03', {}),
  day('2026-11-26', { holiday: true }),
  day('2026-11-27', { earlyClose: true, closeEt: '13:00' }),
]);
cal.delete('2026-11-03'); // a weekday missing from the calendar

const at = (iso: string) => Date.parse(iso);

describe('sessions', () => {
  test('regular hours are Open, with the open guard for the first 20 minutes', () => {
    expect(sessionAt(at('2026-11-02T14:30:00Z'), cal)).toMatchObject({ status: Status.Open, openGuard: true }); // 09:30 EST
    expect(sessionAt(at('2026-11-02T14:49:00Z'), cal).openGuard).toBe(true);
    expect(sessionAt(at('2026-11-02T14:50:00Z'), cal)).toMatchObject({ status: Status.Open, openGuard: false });
  });

  test('16:00 sharp is already Extended, and the minute before is still Open', () => {
    expect(sessionAt(at('2026-11-02T20:59:00Z'), cal).status).toBe(Status.Open);
    expect(sessionAt(at('2026-11-02T21:00:00Z'), cal).status).toBe(Status.Extended);
  });

  test('before the open on a weekday is Extended (Chainlink runs 24/5)', () => {
    expect(sessionAt(at('2026-11-02T12:00:00Z'), cal).status).toBe(Status.Extended);
  });

  test('the weekend runs from Saturday 02:00 to Monday 02:00 Berlin time', () => {
    expect(sessionAt(at('2026-10-31T00:30:00Z'), cal).status).toBe(Status.Extended); // Sat 01:30 Berlin: not yet
    expect(sessionAt(at('2026-10-31T01:00:00Z'), cal).status).toBe(Status.Weekend); // Sat 02:00 Berlin
    expect(sessionAt(at('2026-11-01T15:00:00Z'), cal).status).toBe(Status.Weekend); // Sunday
    expect(sessionAt(at('2026-11-02T00:30:00Z'), cal).status).toBe(Status.Weekend); // Mon 01:30 Berlin: still
  });

  test('Monday 02:00 Berlin reopens trading and starts an open guard', () => {
    const r = sessionAt(at('2026-11-02T01:00:00Z'), cal);
    expect(r.status).toBe(Status.Extended);
    expect(r.openGuard).toBe(true);
    expect(sessionAt(at('2026-11-02T01:30:00Z'), cal).openGuard).toBe(false); // 02:30 is past the 20-minute guard
  });

  test('an exchange holiday is held like a weekend', () => {
    expect(sessionAt(at('2026-11-26T15:00:00Z'), cal)).toMatchObject({ status: Status.Weekend, reason: 'exchange holiday' });
  });

  test('an early close ends the regular session at 13:00 ET', () => {
    expect(sessionAt(at('2026-11-27T17:59:00Z'), cal).status).toBe(Status.Open); // 12:59 EST
    expect(sessionAt(at('2026-11-27T18:00:00Z'), cal).status).toBe(Status.Extended);
  });

  test('a weekday missing from the calendar is Frozen, never guessed', () => {
    expect(sessionAt(at('2026-11-03T15:00:00Z'), cal)).toMatchObject({ status: Status.Frozen });
  });

  test('the mint window follows daylight saving time', () => {
    // Saturday before the CET switch (Berlin is on summer time, UTC+2): 02:00 Berlin is 00:00Z.
    const summer = buildCalendar([day('2026-10-23')]);
    expect(sessionAt(at('2026-10-24T00:30:00Z'), summer).status).toBe(Status.Weekend);
    expect(sessionAt(at('2026-10-23T23:30:00Z'), summer).status).not.toBe(Status.Weekend);
  });
});

describe('zonedTimeToUtc', () => {
  test('converts New York wall-clock times, summer and winter', () => {
    expect(zonedTimeToUtc('2026-10-30', '15:58:45.050', 'America/New_York')).toBe(Date.UTC(2026, 9, 30, 19, 58, 45, 50)); // EDT
    expect(zonedTimeToUtc('2026-11-02', '09:30', 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 14, 30)); // EST
  });

  test('is right on the clock-change day itself', () => {
    expect(zonedTimeToUtc('2026-11-01', '12:00:00', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 17, 0)); // already EST
    expect(zonedTimeToUtc('2026-11-01', '00:30:00', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 4, 30)); // still EDT
  });
});

describe('calendar horizon and profiles', () => {
  test('counts the days of coverage ahead of now', () => {
    const c = buildCalendar([day('2027-12-31')]);
    expect(calendarHorizonDays(c, Date.UTC(2026, 9, 30))).toBe(427);
  });

  test('default session profiles match the spec table', () => {
    expect(DEFAULT_PROFILES[Status.Open]).toMatchObject({ opensAllowed: true, leverage: { micro: 3, small: 3 }, extraSpreadBps: 0 });
    expect(DEFAULT_PROFILES[Status.Weekend]).toMatchObject({ opensAllowed: true, perWallet: true, extraSpreadBps: 150, liquidation: 'margin_only' });
    expect(DEFAULT_PROFILES[Status.Frozen].opensAllowed).toBe(false);
    expect(DEFAULT_PROFILES[Status.Halted]).toMatchObject({ opensAllowed: false, extraSpreadBps: 300 });
  });
});
