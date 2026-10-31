import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp } from 'drizzle-orm/pg-core';

// Only what the product cannot get from the chain or from config files:
// - positions and trades: fast account pages (the chain is the source of truth; both can be rebuilt by replay)
// - orders: signed stop/limit/TP-SL orders waiting for a keeper
// - leases and cursor: failover and resume points for the services
// Prices, charts, calendar, halts and markets are NOT stored (live feeds, TradingView, JSON config).
const u256 = (name: string) => numeric(name, { precision: 78, scale: 0 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const positions = pgTable(
  'positions',
  {
    trader: text('trader').notNull(),
    marketId: text('market_id').notNull(),
    sizeE18: u256('size_e18').notNull(),
    entryE18: u256('entry_e18').notNull(),
    marginUsdg: u256('margin_usdg').notNull(),
    openedAt: ts('opened_at'),
    updatedBlock: bigint('updated_block', { mode: 'bigint' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.trader, t.marketId] })],
);

export const trades = pgTable(
  'trades',
  {
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    block: bigint('block', { mode: 'bigint' }).notNull(),
    at: ts('at').notNull(),
    trader: text('trader').notNull(),
    marketId: text('market_id').notNull(),
    sizeDeltaE18: u256('size_delta_e18').notNull(),
    priceE18: u256('price_e18').notNull(),
    feeUsdg: u256('fee_usdg').notNull(),
    realizedPnlUsdg: u256('realized_pnl_usdg').notNull(),
    path: smallint('path').notNull(), // 0 quote | 1 order | 2 closeAtMark | 3 liquidation
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index('trades_trader_time').on(t.trader, t.at)],
);

export const orders = pgTable(
  'orders',
  {
    nonce: bigint('nonce', { mode: 'bigint' }).notNull(),
    trader: text('trader').notNull(),
    marketId: text('market_id').notNull(),
    kind: smallint('kind').notNull(), // 0 limit | 1 stop | 2 tp | 3 sl | 4 twapSlice
    triggerE18: u256('trigger_e18').notNull(),
    triggerAbove: boolean('trigger_above').notNull(),
    validAfter: ts('valid_after').notNull(),
    expiry: ts('expiry').notNull(),
    body: jsonb('body').notNull(),
    sig: text('sig').notNull(),
    status: text('status').notNull(), // open | filled | cancelled | expired | failed
    fillTx: text('fill_tx'),
    failReason: text('fail_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.trader, t.nonce] }), index('orders_open').on(t.status, t.marketId)],
);

/** Postgres leases for publisher/keeper failover. */
export const leases = pgTable('leases', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const indexerCursor = pgTable('indexer_cursor', {
  name: text('name').primaryKey(),
  block: bigint('block', { mode: 'bigint' }).notNull(),
});
