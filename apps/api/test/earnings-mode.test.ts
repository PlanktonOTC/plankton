import { describe, expect, test } from 'bun:test';
import { earningsModeFor } from '../src/earnings-mode.ts';

const earnings = [{ symbol: 'WYFI', next: { date: '2026-11-18' } }];

describe('earningsModeFor', () => {
  test('activates one New York calendar day before through one day after earnings', () => {
    expect(earningsModeFor(earnings, 'WYFI', Date.parse('2026-11-17T17:00:00Z')).active).toBe(true);
    expect(earningsModeFor(earnings, 'WYFI', Date.parse('2026-11-18T17:00:00Z')).maxLeverageE18).toBe(10n ** 18n);
    expect(earningsModeFor(earnings, 'WYFI', Date.parse('2026-11-20T17:00:00Z')).active).toBe(false);
  });

  test('does not activate for another market or missing earnings data', () => {
    expect(earningsModeFor(earnings, 'CLSK', Date.parse('2026-11-18T17:00:00Z')).active).toBe(false);
    expect(earningsModeFor([], 'WYFI', Date.now()).maxLeverageE18).toBeNull();
  });
});
