import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { loadCalendar, loadEnv, loadMarketData, loadMarkets } from '@plankton/config';
import { MarkRunner } from '../src/runner.ts';

// The runner refreshing its own market data, with Robinhood's answers faked and the cache pointed at a temp folder.
const realFetch = globalThis.fetch;
let dir = '';

// Market caps follow what is on file (a few percent up), so the 3x sanity guard is not what is being tested here.
const onFile = loadMarketData();
const answer = (symbols: string[], over: { date?: string; skip?: string } = {}) => {
  const f = symbols.map((s) => (s === over.skip ? null : { market_cap: String(Math.round((onFile[s]?.marketCapUsd ?? 500_000_000) * 1.03)), average_volume: '3000000', market_date: '2026-11-17' }));
  const q = symbols.filter((s) => s !== over.skip).map((symbol) => ({ symbol, previous_close: '5.00', previous_close_date: over.date ?? '2026-11-16' }));
  return { f, q };
};

function fakeRobinhood(over: Parameters<typeof answer>[1] = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const symbols = decodeURIComponent(new URL(u).searchParams.get('symbols') ?? '').split(',');
    const { f, q } = answer(symbols, over);
    return new Response(JSON.stringify({ results: u.includes('/fundamentals/') ? f : q }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const newRunner = (env: Record<string, string> = {}) => {
  const base = loadEnv();
  const { markets } = loadMarkets();
  const { calendar } = loadCalendar();
  return new MarkRunner({ env: { ...base, ...env } as typeof base, markets, calendar, client: {} as never, sink: { onDecision() {} }, log: pino({ level: 'silent' }) });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mdr-'));
  process.env.MARKET_DATA_CACHE = join(dir, 'live.json');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MARKET_DATA_CACHE;
  rmSync(dir, { recursive: true, force: true });
});

describe('MarkRunner.refreshMarketData', () => {
  test('rebuilds every configured market, makes it fresh, and keeps the result across a restart', async () => {
    const calls = fakeRobinhood({ date: '2026-11-16' });
    const runner = newRunner();
    const report = await runner.refreshMarketData(Date.parse('2026-11-17T10:00:00Z'));
    expect(report).not.toBeNull();
    expect(Object.keys(report!.failed)).toEqual([]);
    expect(report!.updated.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.includes('/fundamentals/'))).toBe(true);
    expect(calls.some((c) => c.includes('/quotes/'))).toBe(true);

    // the row is the figures Robinhood gave, dated by the close they describe
    const shown = runner.eligibility().find((e) => e.symbol === report!.updated[0])!;
    expect(shown.data).toMatchObject({ marketCapUsd: Math.round(onFile[shown.symbol]!.marketCapUsd * 1.03), avgDailyDollarVolumeUsd: 15_000_000, asOf: '2026-11-16' });

    // it was written down, so a restart starts from it
    expect(existsSync(join(dir, 'live.json'))).toBe(true);
    const restarted = newRunner();
    await restarted.pollMarketData();
    expect(restarted.eligibility().find((e) => e.symbol === report!.updated[0])!.data?.asOf).toBe('2026-11-16');
  });

  test('a second run with the same figures changes nothing and writes nothing new', async () => {
    fakeRobinhood();
    const runner = newRunner();
    const now = Date.parse('2026-11-17T10:00:00Z');
    await runner.refreshMarketData(now);
    const before = readFileSync(join(dir, 'live.json'), 'utf8');
    const again = await runner.refreshMarketData(now + 6 * 3_600_000);
    expect(again!.updated).toEqual([]);
    expect(again!.unchanged.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'live.json'), 'utf8')).toBe(before);
  });

  test('a ticker Robinhood does not answer for is reported and keeps its old figures', async () => {
    const { markets } = loadMarkets();
    const skip = markets[0]!.symbol;
    fakeRobinhood({ skip });
    const runner = newRunner();
    await runner.pollMarketData();
    const before = runner.eligibility().find((e) => e.symbol === skip)!.data;
    const report = await runner.refreshMarketData(Date.parse('2026-11-17T10:00:00Z'));
    expect(report!.failed[skip]).toBeDefined();
    expect(runner.health().marketDataRefresh?.failed[skip]).toBeDefined();
    expect(runner.eligibility().find((e) => e.symbol === skip)!.data).toEqual(before);
  });

  test('a network failure throws (the scheduler logs it) and leaves the figures as they were', async () => {
    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const runner = newRunner();
    await expect(runner.refreshMarketData()).rejects.toThrow('offline');
    expect(existsSync(join(dir, 'live.json'))).toBe(false);
  });

  test('switched off it does nothing and does not touch the network', async () => {
    const calls = fakeRobinhood();
    const report = await newRunner({ MARKET_DATA_REFRESH: 'off' }).refreshMarketData();
    expect(report).toBeNull();
    expect(calls).toEqual([]);
  });
});
