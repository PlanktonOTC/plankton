import { zonedTimeToUtc } from '@plankton/core';

export interface Halt {
  symbol: string;
  /** The issuer and security, as Nasdaq names it ("Edible Garden AG Inc Cmn"). */
  issueName: string;
  market: string;
  reasonCode: string;
  /** Set for a volatility pause (LUDP): the price band that triggered it. */
  pauseThresholdPrice: number | null;
  startedAt: number;
  /** When trading resumes (ms). null = no resumption time published yet, i.e. still halted indefinitely. */
  resumesAt: number | null;
}

const ET = 'America/New_York';

const field = (item: string, name: string): string => {
  const m = new RegExp(`<ndaq:${name}\\s*(?:/>|>([^<]*)</ndaq:${name}>)`).exec(item);
  return (m?.[1] ?? '').trim();
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name]!);

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
    const threshold = Number(field(item, 'PauseThresholdPrice'));
    halts.push({
      symbol,
      issueName: decodeEntities(field(item, 'IssueName')),
      market: field(item, 'Market'),
      reasonCode: field(item, 'ReasonCode'),
      pauseThresholdPrice: Number.isFinite(threshold) && threshold > 0 ? threshold : null,
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

/**
 * Nasdaq's halt and resumption codes in plain words (nasdaqtrader.com trade-halt codes). Unknown codes are shown as the
 * code itself, never guessed at.
 */
export const HALT_REASONS: Record<string, string> = {
  T1: 'News pending',
  T2: 'News released',
  T3: 'News and resumption times',
  T5: 'Single-stock trading pause',
  T6: 'Extraordinary market activity',
  T7: 'Single-stock pause, quotation-only period',
  T8: 'Exchange-traded fund halt',
  T12: 'Additional information requested by Nasdaq',
  H4: 'Non-compliance with listing rules',
  H9: 'Not current in required filings',
  H10: 'SEC trading suspension',
  H11: 'Regulatory concern',
  O1: 'Operations halt',
  IPO1: 'IPO not yet trading',
  IPOQ: 'IPO released for quotation',
  IPOE: 'IPO positioning window extended',
  M1: 'Corporate action',
  M2: 'Quotation not available',
  LUDP: 'Volatility trading pause (limit up-limit down)',
  LUDS: 'Volatility trading pause, straddle condition',
  MWC0: 'Market-wide circuit breaker carried over from the previous day',
  MWC1: 'Market-wide circuit breaker, level 1',
  MWC2: 'Market-wide circuit breaker, level 2',
  MWC3: 'Market-wide circuit breaker, level 3',
  MWCQ: 'Market-wide circuit breaker resumption',
  R1: 'New issue available',
  R2: 'Issue available',
  R4: 'Qualification issues resolved; trading to resume',
  R9: 'Filing requirements met; trading to resume',
  C3: 'Issuer news not forthcoming; trading to resume',
  C4: 'Qualification halt ended; trading to resume',
  C9: 'Qualification halt ended, filings met; trading to resume',
  C11: 'Halt ended by another regulator; trading to resume',
  D: 'Security deleted from listing',
};

export type HaltState = 'halted' | 'resuming' | 'resumed';

export interface HaltBoardRow extends Halt {
  reason: string;
  /** halted: no resumption time yet. resuming: a resumption time is published and still ahead. resumed: trading again. */
  state: HaltState;
  /** Whether the stock is one of our markets. */
  listed: boolean;
}

const haltKey = (h: Halt) => `${h.symbol}|${h.startedAt}|${h.reasonCode}`;

/**
 * The halts seen over the last few days. Nasdaq's RSS only lists the current window, so each poll is merged in: a halt
 * keeps its place after it drops off the feed, and a resumption time published later updates the same entry.
 */
export class HaltLog {
  private readonly entries = new Map<string, Halt>();
  constructor(private readonly keepMs = 3 * 86_400_000) {}

  /** A halt still on the feed is always kept, however old (regulatory halts can last months); one that has left the feed
   *  is kept until `keepMs` after it started. */
  merge(halts: Halt[], nowMs: number): void {
    const current = new Set<string>();
    for (const h of halts) {
      const k = haltKey(h);
      current.add(k);
      this.entries.set(k, h);
    }
    for (const [k, h] of this.entries) if (!current.has(k) && h.startedAt < nowMs - this.keepMs) this.entries.delete(k);
  }

  all(): Halt[] {
    return [...this.entries.values()];
  }
}

/** Newest first, with the reason in words and whether trading has resumed. */
export function haltBoard(halts: Halt[], listed: ReadonlySet<string>, nowMs: number): HaltBoardRow[] {
  return halts
    .filter((h) => h.startedAt <= nowMs)
    .map((h) => ({
      ...h,
      reason: HALT_REASONS[h.reasonCode] ?? h.reasonCode,
      state: (h.resumesAt === null ? 'halted' : h.resumesAt > nowMs ? 'resuming' : 'resumed') as HaltState,
      listed: listed.has(h.symbol),
    }))
    .sort((a, b) => b.startedAt - a.startedAt || a.symbol.localeCompare(b.symbol));
}
