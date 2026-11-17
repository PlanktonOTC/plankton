import { describe, expect, test } from 'bun:test';
import { latestFilings, swr } from '../src/tape.ts';

describe('Tape cache', () => {
  test('fresh values are served from cache, stale ones are served while one refresh runs', async () => {
    let clock = 0;
    let loads = 0;
    const get = swr(1_000, 10_000, async () => ++loads, () => {}, () => clock);
    expect((await get()).value).toBe(1);
    clock = 500;
    expect((await get()).value).toBe(1);
    clock = 2_000;
    expect((await get()).value).toBe(1); // stale but served; a refresh starts
    await Bun.sleep(0);
    expect((await get()).value).toBe(2);
    expect(loads).toBe(2);
  });

  test('too old a value waits for a fresh load; concurrent callers share it', async () => {
    let clock = 0;
    let loads = 0;
    const get = swr(1_000, 5_000, async () => { await Bun.sleep(5); return ++loads; }, () => {}, () => clock);
    const [a, b] = await Promise.all([get(), get()]);
    expect([a.value, b.value, loads]).toEqual([1, 1, 1]);
    clock = 60_000;
    expect((await get()).value).toBe(2);
  });

  test('a failed refresh keeps the stale value; a failed first load is an error', async () => {
    let clock = 0;
    let fail = false;
    const errors: unknown[] = [];
    const get = swr(1_000, 10_000, async () => { if (fail) throw new Error('down'); return 'ok'; }, (e) => errors.push(e), () => clock);
    await get();
    fail = true;
    clock = 2_000;
    expect((await get()).value).toBe('ok');
    await Bun.sleep(0);
    expect(errors).toHaveLength(1);
    const first = swr(1_000, 10_000, async () => { throw new Error('down'); });
    await expect(first()).rejects.toThrow('down');
  });

  test('filings from every market merge newest first; flagged keeps medium and high', () => {
    const body = {
      updatedAt: 'now',
      lookbackDays: 45,
      unavailable: [],
      markets: [
        { symbol: 'A', cik: 1, company: 'A Inc', filings: [{ acceptedAt: '2026-11-10T00:00:00.000Z', importance: 'low' }, { acceptedAt: '2026-11-01T00:00:00.000Z', importance: 'high' }] },
        { symbol: 'B', cik: 2, company: 'B Inc', filings: [{ acceptedAt: '2026-11-05T00:00:00.000Z', importance: 'medium' }] },
      ],
    } as any;
    expect(latestFilings(body).map((f) => f.symbol + f.acceptedAt.slice(8, 10))).toEqual(['A10', 'B05', 'A01']);
    expect(latestFilings(body, { flaggedOnly: true, limit: 1 }).map((f) => f.symbol)).toEqual(['B']);
  });
});
