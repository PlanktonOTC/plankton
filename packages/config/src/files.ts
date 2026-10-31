import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { buildCalendar, calendarHorizonDays, RUNGS, type Calendar, type CalendarDay, type MarketData, type Rung } from '@plankton/core';

const CONFIG_DIR = resolve(import.meta.dir, '../../../config');
const readJson = (name: string): unknown => JSON.parse(readFileSync(resolve(CONFIG_DIR, name), 'utf8'));

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address');
const typedAddress = address.transform((v) => v as `0x${string}`);

const deploymentFile = z.object({
  usdg: typedAddress,
  oracle: typedAddress,
  exchange: typedAddress,
  vault: typedAddress,
  backstop: typedAddress,
  firstLoss: typedAddress,
  feeRouter: typedAddress,
  payoutDesk: typedAddress,
  /** Unix seconds of the deploy. The indexer finds the matching block from it. */
  deployedAt: z.number().int().positive(),
});

/** Contract addresses, written by the deploy. One address book, no version picker. */
export function loadDeployment() {
  try {
    return deploymentFile.parse(readJson('../deployments/4663.json'));
  } catch (err) {
    throw new Error(`deployments/4663.json is missing or invalid (deploy the contracts first): ${(err as Error).message}`);
  }
}

const marketsFile = z.object({
  rung: z.enum(Object.keys(RUNGS) as [Rung, ...Rung[]]),
  markets: z.array(
    z.object({
      symbol: z.string().min(1),
      class: z.enum(['micro', 'small', 'smid', 'index']),
      stockToken: address,
      chainlinkFeed: address,
      enabled: z.boolean().default(true),
      /** Max spread between Chainlink and Robinhood for the mark to be openable. Default 150 bps. */
      agreeBps: z.number().int().positive().optional(),
      /** Chainlink staleness limit; set to this feed's heartbeat plus margin. Default 25 h. */
      chainlinkMaxAgeSec: z.number().int().positive().optional(),
      note: z.string().optional(),
    }),
  ),
});

export type MarketConfig = z.infer<typeof marketsFile>['markets'][number];
export interface MarketsConfig {
  rung: Rung;
  markets: MarketConfig[];
}

export function loadMarkets(): MarketsConfig {
  const parsed = marketsFile.parse(readJson('markets.json'));
  const seen = new Set<string>();
  for (const m of parsed.markets) {
    if (seen.has(m.symbol)) throw new Error(`duplicate market symbol ${m.symbol}`);
    seen.add(m.symbol);
  }
  const limit = RUNGS[parsed.rung].maxMarkets;
  const enabled = parsed.markets.filter((m) => m.enabled);
  if (enabled.length > limit) throw new Error(`rung ${parsed.rung} allows ${limit} markets, config enables ${enabled.length}`);
  return { rung: parsed.rung, markets: enabled };
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const marketDataRow = z.object({
  marketCapUsd: z.number().positive(),
  avgDailyDollarVolumeUsd: z.number().nonnegative(),
  asOf: ymd,
  /** Optional counters you keep: consecutive sessions above $2B and above $10B. */
  sessionsAbove2B: z.number().int().nonnegative().optional(),
  sessionsAbove10B: z.number().int().nonnegative().optional(),
});

/** The hand-maintained figures the listing rule needs. Keys starting with "_" are notes and are skipped. */
export function loadMarketData(): Record<string, MarketData> {
  const raw = readJson('market-data.json') as Record<string, unknown>;
  const out: Record<string, MarketData> = {};
  for (const [symbol, row] of Object.entries(raw)) {
    if (symbol.startsWith('_')) continue;
    const parsed = marketDataRow.safeParse(row);
    if (!parsed.success) throw new Error(`config/market-data.json: ${symbol}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    out[symbol] = parsed.data;
  }
  return out;
}
const calendarFile = z.object({
  from: ymd,
  to: ymd,
  holidays: z.array(ymd),
  earlyCloses: z.array(ymd),
});

/** Every weekday in [from, to] gets a row: regular 09:30-16:00 ET, 13:00 on early closes, holiday flag on closures. */
export function loadCalendar(nowMs = Date.now()): { calendar: Calendar; horizonDays: number } {
  const f = calendarFile.parse(readJson('calendar.json'));
  const holidays = new Set(f.holidays);
  const early = new Set(f.earlyCloses);
  const rows: CalendarDay[] = [];
  for (let t = Date.parse(`${f.from}T00:00:00Z`); t <= Date.parse(`${f.to}T00:00:00Z`); t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    rows.push({
      day,
      holiday: holidays.has(day),
      earlyClose: early.has(day),
      openEt: '09:30',
      closeEt: early.has(day) ? '13:00' : '16:00',
    });
  }
  const calendar = buildCalendar(rows);
  return { calendar, horizonDays: calendarHorizonDays(calendar, nowMs) };
}

/** The spec fails CI when the calendar covers under 400 days. Services call this at start-up. */
export const MIN_CALENDAR_HORIZON_DAYS = 400;
