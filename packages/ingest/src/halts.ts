import { zonedTimeToUtc } from '@plankton/core';

export interface Halt {
  symbol: string;
  market: string;
  reasonCode: string;
  startedAt: number;
  /** When trading resumes (ms). null = no resumption time published yet, i.e. still halted indefinitely. */
  resumesAt: number | null;
}

const ET = 'America/New_York';

const field = (item: string, name: string): string => {
  const m = new RegExp(`<ndaq:${name}\\s*(?:/>|>([^<]*)</ndaq:${name}>)`).exec(item);
  return (m?.[1] ?? '').trim();
};

/** "10/30/2026" -> "2026-10-30" */
const mdyToYmd = (s: string): string | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : null;
};

/**
 * Parse the Nasdaq Trader trade-halts RSS. Times carry no zone and are US Eastern.
 * Items with an unparseable start time are skipped (we cannot tell whether they are active).
 */
export function parseHaltsRss(xml: string): Halt[] {
  const halts: Halt[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]!;
    const symbol = field(item, 'IssueSymbol');
    const haltDay = mdyToYmd(field(item, 'HaltDate'));
    const haltTime = field(item, 'HaltTime');
    if (!symbol || !haltDay || !haltTime) continue;

    const resDay = mdyToYmd(field(item, 'ResumptionDate'));
    const resTime = field(item, 'ResumptionTradeTime');
    halts.push({
      symbol,
      market: field(item, 'Market'),
      reasonCode: field(item, 'ReasonCode'),
      startedAt: zonedTimeToUtc(haltDay, haltTime, ET),
      resumesAt: resDay && resTime ? zonedTimeToUtc(resDay, resTime, ET) : null,
    });
  }
  return halts;
}

export async function fetchHalts(url: string): Promise<Halt[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return parseHaltsRss((await res.text()).replace(/^﻿/, ''));
}

/** Symbols that are halted at `nowMs`: started and not yet resumed. */
export function activeHalts(halts: Halt[], nowMs: number): Map<string, Halt> {
  const out = new Map<string, Halt>();
  for (const h of halts) {
    if (h.startedAt > nowMs) continue;
    if (h.resumesAt !== null && h.resumesAt <= nowMs) continue;
    out.set(h.symbol, h);
  }
  return out;
}
