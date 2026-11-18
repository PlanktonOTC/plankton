import { describe, expect, test } from 'bun:test';
import { alertHit, describeAlert, parseAlert } from '../src/price-alerts.ts';

const symbols = ['WYFI', 'RCAT', 'CLSK'];
const e18 = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

describe('price alerts', () => {
  test('/alert accepts > and < in the forms people type', () => {
    expect(parseAlert(['WYFI', '>', '9.50'], symbols)).toEqual({ symbol: 'WYFI', above: true, priceE18: e18('9.5') });
    expect(parseAlert(['wyfi', '<', '$8'], symbols)).toEqual({ symbol: 'WYFI', above: false, priceE18: e18('8') });
    expect(parseAlert(['RCAT', '>3.42'], symbols)).toEqual({ symbol: 'RCAT', above: true, priceE18: e18('3.42') });
    expect(parseAlert(['CLSK', 'below', '6.1'], symbols)).toEqual({ symbol: 'CLSK', above: false, priceE18: e18('6.1') });
    expect(parseAlert(['RCAT', '>=', '.5'], symbols)).toEqual({ symbol: 'RCAT', above: true, priceE18: e18('0.5') });
  });

  test('/alert explains what is wrong instead of guessing', () => {
    expect(parseAlert([], symbols)).toMatch(/^Usage/);
    expect(parseAlert(['WYFI', '9.5'], symbols)).toMatch(/^Usage/);
    expect(parseAlert(['NVDA', '>', '100'], symbols)).toMatch(/Unknown market/);
    expect(parseAlert(['WYFI', '>', '0'], symbols)).toMatch(/above 0/);
    expect(parseAlert(['WYFI', '>', '1.1234567'], symbols)).toMatch(/6 decimal/);
  });

  test('an alert fires at the level or beyond it, in its own direction only', () => {
    const level = e18('9.5');
    expect(alertHit(true, level, e18('9.5'))).toBe(true);
    expect(alertHit(true, level, e18('9.6'))).toBe(true);
    expect(alertHit(true, level, e18('9.49'))).toBe(false);
    expect(alertHit(false, level, e18('9.5'))).toBe(true);
    expect(alertHit(false, level, e18('9.4'))).toBe(true);
    expect(alertHit(false, level, e18('9.51'))).toBe(false);
  });

  test('alerts read the way people set them', () => {
    expect(describeAlert({ symbol: 'WYFI', above: true, priceE18: e18('9.5') })).toBe('WYFI above $9.50');
    expect(describeAlert({ symbol: 'RCAT', above: false, priceE18: e18('3.4215').toString() })).toBe('RCAT below $3.4215');
  });
});
