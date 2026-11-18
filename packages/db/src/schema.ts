import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp } from 'drizzle-orm/pg-core';

// Indexed or cached data that is expensive to query repeatedly but can be rebuilt from the chain/config:
// - positions and trades: fast account pages (the chain is the source of truth; both can be rebuilt by replay)
// - Counter events and hourly NAV/share snapshots: analytics history (the chain remains the source of truth)
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
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index('trades_trader_time').on(t.trader, t.at), index('trades_at').on(t.at)],
);

/** Hourly, flow-neutral Counter share-price history. Starts collecting when this indexer version is deployed. */
export const counterNavSnapshots = pgTable('counter_nav_snapshots', {
  hour: bigint('hour', { mode: 'bigint' }).primaryKey(),
  block: bigint('block', { mode: 'bigint' }).notNull(),
  at: ts('at').notNull(),
  navUsdg: u256('nav_usdg').notNull(),
  navPerShareE18: u256('nav_per_share_e18').notNull(),
  totalShares: u256('total_shares').notNull(),
});

/** Contract-emitted Counter-specific cash drivers that are not represented by TradeExecuted rows. */
export const counterActivity = pgTable(
  'counter_activity',
  {
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    block: bigint('block', { mode: 'bigint' }).notNull(),
    at: ts('at').notNull(),
    kind: text('kind').notNull(), // fee_income | bad_debt | bad_debt_covered
    marketId: text('market_id'),
    amountUsdg: u256('amount_usdg').notNull(),
    details: jsonb('details').notNull(),
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index('counter_activity_kind_time').on(t.kind, t.at)],
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

/** Telegram account binding. Only a wallet-signed, short-lived link code can create one. */
export const telegramLinks = pgTable('telegram_links', {
  wallet: text('wallet').primaryKey(),
  chatId: text('chat_id').notNull().unique(),
  username: text('username'),
  linkedAt: ts('linked_at').notNull().defaultNow(),
});

export const telegramChallenges = pgTable('telegram_challenges', {
  nonce: text('nonce').primaryKey(),
  wallet: text('wallet').notNull(),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
});

/** One-time deep-link codes; the raw token is never stored. */
export const telegramLinkCodes = pgTable('telegram_link_codes', {
  tokenHash: text('token_hash').primaryKey(),
  wallet: text('wallet').notNull(),
  expiresAt: ts('expires_at').notNull(),
  linkedAt: ts('linked_at'),
});

/** Telegram price alerts. One-shot: a row is deleted when its alert fires or the chat removes it. */
export const telegramPriceAlerts = pgTable(
  'telegram_price_alerts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    chatId: text('chat_id').notNull(),
    symbol: text('symbol').notNull(),
    above: boolean('above').notNull(),
    priceE18: u256('price_e18').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('telegram_price_alerts_chat').on(t.chatId)],
);

/** Telegram long-poll cursor shared by API replicas. */
export const telegramBotState = pgTable('telegram_bot_state', {
  singleton: boolean('singleton').primaryKey().default(true),
  nextUpdateId: bigint('next_update_id', { mode: 'bigint' }).notNull(),
});

/** Browser Web Push subscriptions for liquidation warnings. */
export const pushSubscriptions = pgTable('push_subscriptions', {
  endpoint: text('endpoint').notNull(),
  wallet: text('wallet').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.wallet, t.endpoint] }), index('push_subscriptions_wallet').on(t.wallet)]);

/** One-time wallet-signed subscription registration challenges. */
export const liquidationChallenges = pgTable('liquidation_challenges', {
  nonce: text('nonce').primaryKey(),
  wallet: text('wallet').notNull(),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
});

/** Highest warning band already sent for a position; reset after it moves safely away. */
export const liquidationWarningStates = pgTable('liquidation_warning_states', {
  wallet: text('wallet').notNull(),
  marketId: text('market_id').notNull(),
  level: smallint('level').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.wallet, t.marketId] })]);
