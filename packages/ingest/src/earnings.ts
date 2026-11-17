import { z } from 'zod';

// Earnings dates for the catalyst calendar, from Robinhood's public, key-free earnings endpoint (one symbol per request).
// Upcoming dates are often provisional until the company confirms them; `verified` says which.

const num = z.string().nullable().optional();
const item = z.looseObject({
  symbol: z.string(),
  year: z.number(),
  quarter: z.number(),
  eps: z.object({ estimate: num, actual: num }).nullable().optional(),
  report: z
    .object({
      date: z.string(),
      time: z.string().nullable().optional(),
      timing: z.string().nullable().optional(),
      verified: z.boolean().nullable().optional(),
    })
    .nullable()
    .optional(),
});
const response = z.object({ results: z.array(item) });
export type EarningsItem = z.infer<typeof item>;

export interface UpcomingEarnings {
  year: number;
  quarter: number;
  date: string;
  /** Exact release time when one is published (ISO), else null. */
  time: string | null;
  /** am: before the US open. pm: after the close. null: not stated. */
  timing: 'am' | 'pm' | null;
  /** False while the date is an estimate the company has not confirmed. */
  verified: boolean;
  epsEstimate: number | null;
}

export interface LastEarnings {
  year: number;
  quarter: number;
  date: string;
  epsEstimate: number | null;
  epsActual: number;
  /** (actual - estimate) / |estimate|, in percent. Null without an estimate or when the estimate is zero. */
  surprisePct: number | null;
}

export interface EarningsSummary {
  symbol: string;
  next: UpcomingEarnings | null;
  last: LastEarnings | null;
}

const toNum = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** The next report on or after `todayYmd` that has no result yet, and the latest report that has one. */
export function summarizeEarnings(symbol: string, items: EarningsItem[], todayYmd: string): EarningsSummary {
  const dated = items.filter((i) => i.report?.date).sort((a, b) => a.report!.date.localeCompare(b.report!.date));
  const upcoming = dated.find((i) => i.report!.date >= todayYmd && toNum(i.eps?.actual) === null);
  const reported = [...dated].reverse().find((i) => toNum(i.eps?.actual) !== null);

  let last: LastEarnings | null = null;
  if (reported) {
    const actual = toNum(reported.eps?.actual)!;
    const estimate = toNum(reported.eps?.estimate);
    last = {
      year: reported.year,
      quarter: reported.quarter,
      date: reported.report!.date,
      epsEstimate: estimate,
      epsActual: actual,
      surprisePct: estimate !== null && estimate !== 0 ? Math.round(((actual - estimate) / Math.abs(estimate)) * 1000) / 10 : null,
    };
  }
  const timing = upcoming?.report?.timing;
  return {
    symbol,
    next: upcoming
      ? {
          year: upcoming.year,
          quarter: upcoming.quarter,
          date: upcoming.report!.date,
          time: upcoming.report!.time ?? null,
          timing: timing === 'am' || timing === 'pm' ? timing : null,
          verified: upcoming.report!.verified === true,
          epsEstimate: toNum(upcoming.eps?.estimate),
        }
      : null,
    last,
  };
}

export function parseEarnings(json: unknown): EarningsItem[] {
  return response.parse(json).results;
}

/** `base` is https://api.robinhood.com. Throws on a failed request so a gap is never mistaken for "no earnings". */
export async function fetchEarnings(base: string, symbol: string): Promise<EarningsItem[]> {
  const url = `${base.replace(/\/$/, '')}/marketdata/earnings/?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return parseEarnings(await res.json());
}
