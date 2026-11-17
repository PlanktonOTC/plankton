import { z } from 'zod';
import type { FundamentalsRow, QuoteRow } from '@plankton/core';

// Robinhood's public, key-free stock endpoints (the ones its own website reads): fundamentals for market cap and average
// volume, quotes for the previous close and its date. Both answer lists, so a batch of tickers is one request each.

const fundamentalsItem = z.looseObject({
  market_cap: z.string().nullable().optional(),
  average_volume: z.string().nullable().optional(),
  market_date: z.string().nullable().optional(),
  instrument: z.string().nullable().optional(),
});
const fundamentalsResponse = z.object({ results: z.array(fundamentalsItem.nullable()) });

const quoteItem = z.looseObject({
  symbol: z.string(),
  previous_close: z.string().nullable().optional(),
  adjusted_previous_close: z.string().nullable().optional(),
  previous_close_date: z.string().nullable().optional(),
});
const quotesResponse = z.object({ results: z.array(quoteItem.nullable()) });

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

const BATCH = 25;
const chunk = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/**
 * Fundamentals and quotes for each ticker, keyed by symbol. `base` is https://api.robinhood.com. A ticker Robinhood does not
 * know is simply absent from the maps (the caller reports it); a failed request throws, so a half answer is never mistaken
 * for a whole one.
 */
export async function fetchStockFigures(base: string, symbols: string[]): Promise<{ fundamentals: Record<string, FundamentalsRow>; quotes: Record<string, QuoteRow> }> {
  const root = base.replace(/\/$/, '');
  const fundamentals: Record<string, FundamentalsRow> = {};
  const quotes: Record<string, QuoteRow> = {};
  for (const batch of chunk(symbols, BATCH)) {
    const list = batch.map(encodeURIComponent).join(',');
    const [f, q] = await Promise.all([
      getJson(`${root}/fundamentals/?symbols=${list}`).then((j) => fundamentalsResponse.parse(j).results),
      getJson(`${root}/quotes/?symbols=${list}`).then((j) => quotesResponse.parse(j).results),
    ]);
    // The fundamentals answer has no symbol of its own: it comes back in the order asked, with null for an unknown ticker.
    batch.forEach((symbol, i) => {
      const row = f[i];
      if (row) fundamentals[symbol] = row;
    });
    for (const row of q) if (row) quotes[row.symbol] = row;
  }
  return { fundamentals, quotes };
}
