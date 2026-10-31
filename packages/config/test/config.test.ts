import { describe, expect, test } from 'bun:test';
import { Status } from '@plankton/core';
import { MIN_CALENDAR_HORIZON_DAYS, eligibilityMode, loadCalendar, loadEnv, loadMarketData, loadMarkets, need, urlList } from '../src/index.ts';

describe('settings', () => {
  test('defaults work with an empty environment', () => {
    const env = loadEnv({});
    expect(env.RPC_URLS).toEqual(['https://rpc.mainnet.chain.robinhood.com']);
    expect(env.API_PORT).toBe(8787);
    expect(env.STOCK_TOKEN_WINDOW_TZ).toBe('Europe/Berlin');
    expect(env.NODE_ENV).toBe('development');
  });

  test('a blank NAME= line in .env means "not set", not an invalid empty value', () => {
    const env = loadEnv({ SIGNER_ROLE: '', SIGNER_PRIVATE_KEY: '', DATABASE_URL: '', PUBLISHER_PRIVATE_KEY: '' });
    expect(env.SIGNER_ROLE).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  test('bad values are refused with the name of the setting', () => {
    expect(() => loadEnv({ SIGNER_ROLE: 'boss' })).toThrow(/SIGNER_ROLE/);
    expect(() => loadEnv({ SIGNER_PRIVATE_KEY: '0x123' })).toThrow(/SIGNER_PRIVATE_KEY/);
    expect(() => loadEnv({ SIGNER_AUTH_TOKEN: 'short' })).toThrow(/SIGNER_AUTH_TOKEN/);
  });

  test('several RPC URLs are split and trimmed', () => {
    expect(loadEnv({ RPC_URLS: ' https://a.example , https://b.example ' }).RPC_URLS).toEqual(['https://a.example', 'https://b.example']);
  });

  test('numbers arrive as numbers', () => {
    expect(loadEnv({ API_PORT: '9000' }).API_PORT).toBe(9000);
    expect(loadEnv({ SIGNER_MAX_NOTIONAL_PER_MIN_USDG: '1000' }).SIGNER_MAX_NOTIONAL_PER_MIN_USDG).toBe(1000n);
  });

  test('need() names what is missing, and urlList() ignores blanks', () => {
    expect(() => need(undefined, 'KEEPER_PRIVATE_KEY')).toThrow('KEEPER_PRIVATE_KEY is required');
    expect(need('x', 'A')).toBe('x');
    expect(urlList('http://a, ,http://b')).toEqual(['http://a', 'http://b']);
    expect(urlList(undefined)).toEqual([]);
  });
});

describe('market list', () => {
  test('the shipped markets.json is valid and within its rung', () => {
    const { rung, markets } = loadMarkets();
    expect(rung).toBe('R0');
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.length).toBeLessThanOrEqual(4);
    for (const m of markets) {
      expect(m.stockToken).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(m.chainlinkFeed).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

describe('listing-rule data', () => {
  test('market-data.json loads, skipping the _readme note', () => {
    const data = loadMarketData();
    expect(Object.keys(data).some((k) => k.startsWith('_'))).toBe(false);
    for (const row of Object.values(data)) {
      expect(row.marketCapUsd).toBeGreaterThan(0);
      expect(row.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('the rule is enforced in production and only reported elsewhere, unless set explicitly', () => {
    expect(eligibilityMode(loadEnv({ NODE_ENV: 'production' }))).toBe('enforce');
    expect(eligibilityMode(loadEnv({ NODE_ENV: 'development' }))).toBe('warn');
    expect(eligibilityMode(loadEnv({ NODE_ENV: 'production', ELIGIBILITY_MODE: 'off' }))).toBe('off');
    expect(() => loadEnv({ ELIGIBILITY_MODE: 'maybe' })).toThrow(/ELIGIBILITY_MODE/);
  });
});

describe('holiday calendar', () => {
  const NOW = Date.UTC(2026, 9, 30);
  const { calendar, horizonDays } = loadCalendar(NOW);

  test('covers well over the 400 days the spec requires', () => {
    expect(horizonDays).toBeGreaterThanOrEqual(MIN_CALENDAR_HORIZON_DAYS);
  });

  test('has a row for every weekday and none for weekends', () => {
    expect(calendar.get('2026-11-02')).toBeDefined(); // Monday
    expect(calendar.get('2026-10-31')).toBeUndefined(); // Saturday
    expect(calendar.get('2026-11-01')).toBeUndefined(); // Sunday
  });

  test('holidays are marked, early closes end at 13:00, ordinary days run 09:30 to 16:00', () => {
    expect(calendar.get('2026-11-26')!.holiday).toBe(true); // Thanksgiving
    expect(calendar.get('2026-12-25')!.holiday).toBe(true);
    expect(calendar.get('2027-03-26')!.holiday).toBe(true); // Good Friday
    expect(calendar.get('2026-11-27')).toMatchObject({ earlyClose: true, closeEt: '13:00', holiday: false });
    expect(calendar.get('2026-11-02')).toMatchObject({ openEt: '09:30', closeEt: '16:00', holiday: false });
  });

  test('the full 2027 list: ten closures and one early close', () => {
    const rows = [...calendar.values()].filter((r) => r.day.startsWith('2027'));
    expect(rows.filter((r) => r.holiday)).toHaveLength(10);
    expect(rows.filter((r) => r.earlyClose).map((r) => r.day)).toEqual(['2027-11-26']);
  });

  test('works with the session logic: Thanksgiving is held, the day after closes early', () => {
    expect(Status.Weekend).toBe(3);
    expect(calendar.get('2026-11-26')!.holiday).toBe(true);
  });
});
