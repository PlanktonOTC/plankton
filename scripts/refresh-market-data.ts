// Rebuilds the figures in config/market-data.json from Robinhood's public stock data.
//
//   bun run scripts/refresh-market-data.ts            show what would change (writes nothing)
//   bun run scripts/refresh-market-data.ts --write    update config/market-data.json
//
// The mark service does this by itself every few hours (MARKET_DATA_REFRESH=on). This script is for committing fresh
// figures into the repository and for checking them by eye first. A row it cannot trust is left as it is and listed.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMarketDataRow, mergeMarketData } from '@plankton/core';
import { loadEnv, loadMarketData, loadMarkets } from '@plankton/config';
import { fetchStockFigures } from '../packages/ingest/src/index.ts';

const write = process.argv.includes('--write');
const env = loadEnv();
const { markets } = loadMarkets();
const symbols = markets.map((m) => m.symbol);
const file = resolve(import.meta.dir, '../config/market-data.json');

const current = loadMarketData();
const { fundamentals, quotes } = await fetchStockFigures(env.RH_FUNDAMENTALS_BASE, symbols);
const todayYmd = new Date().toISOString().slice(0, 10);

const next = { ...current };
const failed: Record<string, string> = {};
const fmt = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
console.log(`${'symbol'.padEnd(7)}${'market cap'.padEnd(24)}${'avg $ volume'.padEnd(24)}${'as of'.padEnd(24)}result`);
for (const symbol of symbols) {
  const r = buildMarketDataRow({ fundamentals: fundamentals[symbol], quote: quotes[symbol], previous: current[symbol], todayYmd });
  const old = current[symbol];
  if (!r.ok) {
    failed[symbol] = r.reason;
    console.log(`${symbol.padEnd(7)}${''.padEnd(72)}KEPT: ${r.reason}`);
    continue;
  }
  next[symbol] = r.row;
  const cell = (a: string | undefined, b: string) => (a === undefined ? b : a === b ? `${b} (same)` : `${a} -> ${b}`).padEnd(24);
  console.log(`${symbol.padEnd(7)}${cell(old && fmt(old.marketCapUsd), fmt(r.row.marketCapUsd))}${cell(old && fmt(old.avgDailyDollarVolumeUsd), fmt(r.row.avgDailyDollarVolumeUsd))}${cell(old?.asOf, r.row.asOf)}${r.changed ? 'UPDATED' : 'unchanged'}`);
}

if (!write) {
  console.log('\nDry run: nothing written. Add --write to update config/market-data.json.');
} else {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  for (const [symbol, row] of Object.entries(mergeMarketData(current, next))) raw[symbol] = row;
  raw._source = `Robinhood public fundamentals and quotes (market cap, average share volume x previous close), pulled ${todayYmd} by scripts/refresh-market-data.ts. The mark service also refreshes these itself every few hours.`;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`\nWrote ${file}`);
}
if (Object.keys(failed).length > 0) process.exitCode = 1;
