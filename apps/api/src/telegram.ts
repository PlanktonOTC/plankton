import { createHash, randomBytes } from 'node:crypto';
import { formatUnits, verifyMessage, type Address, type Hex } from 'viem';
import { and, asc, desc, eq, gt, isNull, sql, telegramBotState, telegramChallenges, telegramLinkCodes, telegramLinks, trades, positions, type Db } from '@plankton/db';
import { acquireLease, releaseLease, telegramEventSubscriptions, telegramEventsAnnounced, telegramLpDaily, telegramPriceAlerts } from '@plankton/db';
import { dailyDue, dailyText, lpText, poolText, type PoolView } from './lp-updates.ts';
import { wantsEvent, type MarketEvent } from './market-events.ts';
import { MAX_ALERTS_PER_CHAT, alertHit, describeAlert, parseAlert, usd } from './price-alerts.ts';
import type { Env } from '@plankton/config';

type TelegramUpdate = { update_id: number; message?: { text?: string; chat: { id: number; type: string }; from?: { username?: string } } };
type TelegramResult<T> = { ok: boolean; result: T };
/** Live Counter figures for /pool, /lp and the daily summary. */
export type LpSources = { getPool: () => Promise<PoolView>; getShares: (wallet: string) => Promise<bigint> };

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const code = () => randomBytes(32).toString('base64url');

/** Never put the token-bearing Telegram URL or error body in logs. */
async function telegram<T>(env: Env, method: string, body: unknown): Promise<T> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Telegram bot is not configured');
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error('Telegram request failed');
  const result = await response.json() as TelegramResult<T>;
  if (!result.ok) throw new Error('Telegram request failed');
  return result.result;
}

function decimal(raw: string, decimals: number, places: number): string {
  const n = Number(formatUnits(BigInt(raw), decimals));
  return n.toLocaleString('en-US', { maximumFractionDigits: places });
}

const HELP = 'Plankton read-only bot\n/price SYMBOL — current Plankton price\n/prices — latest listed prices\n/positions — your open positions\n/trades — your latest fills\n/alert SYMBOL > PRICE — ping me when the price crosses (or <)\n/alerts — your price alerts\n/unalert ID — remove one (or /unalert all)\n/events on — halts, splits, earnings and close-only notices (or /events WYFI RCAT for some markets, /events off)\n/pool — the LP pool: value, share price, 24h and 7d change\n/lp — your LP position (linked wallet)\n/daily on — a daily LP summary after the US close (/daily off)\n/unlink — remove this Telegram link\n/help — commands\n\nLink your wallet in Plankton under Account & deposits → Telegram. Once linked, you get a message here whenever a keeper fills one of your orders (take-profit, stop-loss, limit, ladder or gasless market). This bot cannot place trades.';
const lastWalletLookup = new Map<string, number>();

async function reply(env: Env, chatId: number, text: string): Promise<void> {
  // Plain text only, so ticker names and Telegram usernames cannot inject markup.
  await telegram(env, 'sendMessage', { chat_id: chatId, text: text.slice(0, 3900), link_preview_options: { is_disabled: true } });
}

export async function notifyTelegramWallet(env: Env, db: Db, wallet: string, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const rows = await db.select({ chatId: telegramLinks.chatId }).from(telegramLinks).where(eq(telegramLinks.wallet, wallet.toLowerCase())).limit(1);
  if (!rows[0]) return false;
  await reply(env, Number(rows[0].chatId), text);
  return true;
}

async function handleUpdate(update: TelegramUpdate, env: Env, db: Db, symbols: string[], symbolOf: (marketId: string) => string, getPrices: () => Promise<Map<string, { priceE18: string | null; status: string | null }>>, lp: LpSources) {
  const message = update.message;
  if (!message?.text) return;
  const chatId = String(message.chat.id);
  if (message.chat.type !== 'private') {
    await reply(env, Number(chatId), 'For privacy, use this bot in a private chat.');
    return;
  }
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = (rawCommand ?? '').split('@')[0]!.toLowerCase();

  if (command === '/start') {
    const token = args[0];
    if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
      await reply(env, Number(chatId), 'Welcome to Plankton. Link your wallet in Account & deposits → Telegram, then open the link and tap Start.\n\nUse /help for commands.');
      return;
    }
    const tokenHash = hash(token);
    try {
      const linkedWallet = await db.transaction(async (tx) => {
        const rows = await tx.update(telegramLinkCodes).set({ linkedAt: new Date() })
          .where(and(eq(telegramLinkCodes.tokenHash, tokenHash), gt(telegramLinkCodes.expiresAt, new Date()), isNull(telegramLinkCodes.linkedAt)))
          .returning({ wallet: telegramLinkCodes.wallet });
        const wallet = rows[0]?.wallet;
        if (!wallet) return null;
        await tx.insert(telegramLinks).values({ wallet, chatId, username: message.from?.username ?? null })
          .onConflictDoUpdate({ target: telegramLinks.wallet, set: { chatId, username: message.from?.username ?? null, linkedAt: new Date() } });
        return wallet;
      });
      await reply(env, Number(chatId), linkedWallet ? `Wallet ${linkedWallet.slice(0, 6)}…${linkedWallet.slice(-4)} linked. Use /positions or /trades. This bot is read-only.` : 'That link expired or was already used. Create a fresh link in Plankton.');
    } catch {
      await reply(env, Number(chatId), 'This Telegram chat is already linked to another wallet. Use /unlink there first.');
    }
    return;
  }
  if (command === '/help') return void await reply(env, Number(chatId), HELP);
  if (command === '/unlink') {
    await db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
    return void await reply(env, Number(chatId), 'Telegram link removed.');
  }
  if (command === '/price' || command === '/prices') {
    const prices = await getPrices();
    const requested = command === '/price' ? (args[0] ?? '').toUpperCase() : '';
    if (command === '/price' && !requested) return void await reply(env, Number(chatId), 'Usage: /price SYMBOL');
    if (command === '/price' && !symbols.includes(requested)) return void await reply(env, Number(chatId), 'Unknown market symbol. Use /prices to see listings.');
    const list = command === '/price' ? [requested] : symbols;
    const lines = list.map((symbol) => {
      const mark = prices.get(symbol);
      if (!mark?.priceE18) return `${symbol}: price unavailable${mark?.status ? ` (${mark.status})` : ''}`;
      return `${symbol}: $${decimal(mark.priceE18, 18, 4)}${mark.status && mark.status !== 'open' ? ` (${mark.status})` : ''}`;
    });
    return void await reply(env, Number(chatId), `Plankton prices\n${lines.join('\n')}`);
  }
  if (command === '/alert') {
    const req = parseAlert(args, symbols);
    if (typeof req === 'string') return void await reply(env, Number(chatId), req);
    const existing = await db.select({ id: telegramPriceAlerts.id }).from(telegramPriceAlerts).where(eq(telegramPriceAlerts.chatId, chatId));
    if (existing.length >= MAX_ALERTS_PER_CHAT) return void await reply(env, Number(chatId), `You have ${MAX_ALERTS_PER_CHAT} alerts already. Remove one with /unalert ID.`);
    const now = (await getPrices()).get(req.symbol)?.priceE18;
    if (now && alertHit(req.above, req.priceE18, BigInt(now))) {
      return void await reply(env, Number(chatId), `${req.symbol} is already ${req.above ? 'at or above' : 'at or below'} ${usd(req.priceE18)} (now ${usd(now)}). Pick a level it has not reached yet.`);
    }
    const [row] = await db.insert(telegramPriceAlerts).values({ chatId, symbol: req.symbol, above: req.above, priceE18: req.priceE18.toString() }).returning({ id: telegramPriceAlerts.id });
    return void await reply(env, Number(chatId), `🔔 Alert #${row!.id} set: ${describeAlert(req)}${now ? ` (now ${usd(now)})` : ''}. It fires once. /alerts to list.`);
  }
  if (command === '/pool') return void await reply(env, Number(chatId), poolText(await lp.getPool()));
  if (command === '/lp' || command === '/daily') {
    const linked = await db.select({ wallet: telegramLinks.wallet }).from(telegramLinks).where(eq(telegramLinks.chatId, chatId)).limit(1);
    if (!linked[0]) return void await reply(env, Number(chatId), 'Link your wallet in Plankton under Account & deposits → Telegram first.');
    if (command === '/lp') {
      const [pool, shares] = await Promise.all([lp.getPool(), lp.getShares(linked[0].wallet)]);
      return void await reply(env, Number(chatId), lpText(pool, shares));
    }
    const arg = (args[0] ?? '').toLowerCase();
    if (arg === 'off') {
      await db.delete(telegramLpDaily).where(eq(telegramLpDaily.chatId, chatId));
      return void await reply(env, Number(chatId), 'Daily LP summary is off.');
    }
    if (arg === 'on') {
      await db.insert(telegramLpDaily).values({ chatId }).onConflictDoNothing();
      return void await reply(env, Number(chatId), '📅 Daily LP summary is on: your position, its 24h change and the pool, every weekday after the US close (17:00 New York). /daily off to stop.');
    }
    const [sub] = await db.select().from(telegramLpDaily).where(eq(telegramLpDaily.chatId, chatId)).limit(1);
    return void await reply(env, Number(chatId), sub ? 'Daily LP summary is on. /daily off to stop.' : 'Daily LP summary is off. /daily on to start.');
  }
  if (command === '/events') {
    const arg = args.map((a) => a.toUpperCase());
    if (arg.length === 0) {
      const [sub] = await db.select().from(telegramEventSubscriptions).where(eq(telegramEventSubscriptions.chatId, chatId)).limit(1);
      return void await reply(env, Number(chatId), sub
        ? `Market event notices are on for ${sub.symbols?.length ? sub.symbols.join(', ') : 'every market'}.\n/events off to stop.`
        : 'Market event notices are off.\n/events on for every market, or /events WYFI RCAT for some.');
    }
    if (arg[0] === 'OFF') {
      await db.delete(telegramEventSubscriptions).where(eq(telegramEventSubscriptions.chatId, chatId));
      return void await reply(env, Number(chatId), 'Market event notices are off.');
    }
    const picked = arg[0] === 'ON' ? null : arg;
    const unknown = (picked ?? []).filter((x) => !symbols.includes(x));
    if (unknown.length) return void await reply(env, Number(chatId), `Unknown market symbol: ${unknown.join(', ')}. Use /prices to see listings.`);
    await db.insert(telegramEventSubscriptions).values({ chatId, symbols: picked })
      .onConflictDoUpdate({ target: telegramEventSubscriptions.chatId, set: { symbols: picked } });
    return void await reply(env, Number(chatId), `📣 Market event notices are on for ${picked ? picked.join(', ') : 'every market'}: trading halts and resumptions, pending splits, earnings due, and the close-only evening before a weekend or holiday.\n/events off to stop.`);
  }
  if (command === '/alerts') {
    const rows = await db.select().from(telegramPriceAlerts).where(eq(telegramPriceAlerts.chatId, chatId)).orderBy(asc(telegramPriceAlerts.id));
    if (!rows.length) return void await reply(env, Number(chatId), 'No price alerts. Set one with /alert WYFI > 9.50');
    return void await reply(env, Number(chatId), `Your price alerts\n${rows.map((r) => `#${r.id} · ${describeAlert(r)}`).join('\n')}\n\nRemove one with /unalert ID.`);
  }
  if (command === '/unalert') {
    const target = (args[0] ?? '').toLowerCase();
    if (target === 'all') {
      const gone = await db.delete(telegramPriceAlerts).where(eq(telegramPriceAlerts.chatId, chatId)).returning({ id: telegramPriceAlerts.id });
      return void await reply(env, Number(chatId), `Removed ${gone.length} alert${gone.length === 1 ? '' : 's'}.`);
    }
    if (!/^\d{1,9}$/.test(target)) return void await reply(env, Number(chatId), 'Usage: /unalert ID  (see /alerts), or /unalert all');
    const gone = await db.delete(telegramPriceAlerts).where(and(eq(telegramPriceAlerts.chatId, chatId), eq(telegramPriceAlerts.id, Number(target)))).returning({ id: telegramPriceAlerts.id });
    return void await reply(env, Number(chatId), gone.length ? `Removed alert #${target}.` : `No alert #${target} in this chat.`);
  }
  if (command === '/positions' || command === '/trades') {
    const previousLookup = lastWalletLookup.get(chatId) ?? 0;
    if (Date.now() - previousLookup < 30_000) return void await reply(env, Number(chatId), 'Please wait 30 seconds between wallet lookups.');
    lastWalletLookup.set(chatId, Date.now());
    const linked = await db.select({ wallet: telegramLinks.wallet }).from(telegramLinks).where(eq(telegramLinks.chatId, chatId)).limit(1);
    if (!linked[0]) return void await reply(env, Number(chatId), 'Link your wallet in Plankton under Account & deposits → Telegram first.');
    const wallet = linked[0].wallet;
    if (command === '/positions') {
      const rows = await db.select().from(positions).where(eq(positions.trader, wallet)).orderBy(asc(positions.marketId));
      const open = rows.filter((p) => BigInt(p.sizeE18) !== 0n);
      if (!open.length) return void await reply(env, Number(chatId), 'No open positions found.');
      return void await reply(env, Number(chatId), `Open positions · ${wallet.slice(0, 6)}…${wallet.slice(-4)}\n${open.slice(0, 25).map((p) => `${symbolOf(p.marketId)} · size ${decimal(p.sizeE18, 18, 4)} · margin ${decimal(p.marginUsdg, 6, 2)} USDG`).join('\n')}`);
    }
    const rows = await db.select().from(trades).where(eq(trades.trader, wallet)).orderBy(desc(trades.at)).limit(10);
    if (!rows.length) return void await reply(env, Number(chatId), 'No indexed trades found.');
    return void await reply(env, Number(chatId), `Latest fills · ${wallet.slice(0, 6)}…${wallet.slice(-4)}\n${rows.map((t) => `${t.at.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${symbolOf(t.marketId)} · ${decimal(t.sizeDeltaE18, 18, 4)} @ $${decimal(t.priceE18, 18, 4)} · ${t.txHash.slice(0, 10)}…`).join('\n')}`);
  }
  await reply(env, Number(chatId), 'Unknown command. Use /help.');
}

export function startTelegramBot({ env, db, symbols, symbolOf, getPrices, getMarketEvents, lp, log }: {
  env: Env; db: () => Db; symbols: string[]; symbolOf: (marketId: string) => string; getPrices: () => Promise<Map<string, { priceE18: string | null; status: string | null }>>;
  getMarketEvents: () => Promise<MarketEvent[]>; lp: LpSources; log: { warn: (data: object, message: string) => void };
}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME || !env.DATABASE_URL) return;
  const holder = randomBytes(12).toString('hex');
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    const database = db();
    let locked = false;
    try {
      locked = await acquireLease(database, 'telegram-bot-poller', holder, 30);
      if (!locked) return;
      const state = await database.select().from(telegramBotState).where(eq(telegramBotState.singleton, true)).limit(1);
      let nextUpdateId = state[0]?.nextUpdateId;
      if (nextUpdateId === undefined) {
        const inserted = await database.insert(telegramBotState).values({ singleton: true, nextUpdateId: 0n }).returning({ nextUpdateId: telegramBotState.nextUpdateId });
        nextUpdateId = inserted[0]!.nextUpdateId;
      }
      const updates = await telegram<TelegramUpdate[]>(env, 'getUpdates', { offset: Number(nextUpdateId), timeout: 0, allowed_updates: ['message'] });
      for (const update of updates) {
        try { await handleUpdate(update, env, database, symbols, symbolOf, getPrices, lp); }
        catch { log.warn({ event: 'telegram_update_failed', updateId: update.update_id }, 'Telegram update failed'); }
        await database.update(telegramBotState).set({ nextUpdateId: BigInt(update.update_id + 1) }).where(eq(telegramBotState.singleton, true));
      }
    } catch {
      // The Telegram URL contains the bot token; intentionally log only a fixed event name.
      log.warn({ event: 'telegram_poll_failed' }, 'Telegram polling failed');
    } finally {
      if (locked) await releaseLease(database, 'telegram-bot-poller', holder).catch(() => {});
      busy = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), 5_000);
  timer.unref();

  // Price alerts: every 15 s, one replica checks every alert against the live Plankton price. An alert is deleted before
  // its message is sent, so it can never fire twice.
  let checking = false;
  const checkAlerts = async () => {
    if (checking) return;
    checking = true;
    const database = db();
    let locked = false;
    try {
      locked = await acquireLease(database, 'telegram-price-alerts', holder, 30);
      if (!locked) return;
      const alerts = await database.select().from(telegramPriceAlerts).limit(5_000);
      if (!alerts.length) return;
      const prices = await getPrices();
      for (const a of alerts) {
        const now = prices.get(a.symbol)?.priceE18;
        if (!now || !alertHit(a.above, BigInt(a.priceE18), BigInt(now))) continue;
        const gone = await database.delete(telegramPriceAlerts).where(eq(telegramPriceAlerts.id, a.id)).returning({ id: telegramPriceAlerts.id });
        if (!gone.length) continue;
        await reply(env, Number(a.chatId), `🔔 ${a.symbol} is ${a.above ? 'above' : 'below'} ${usd(a.priceE18)}: now ${usd(now)}.\nAlert #${a.id} is done. Set another with /alert.`).catch(() => {
          log.warn({ event: 'telegram_price_alert_send_failed', id: a.id }, 'price alert not sent');
        });
      }
    } catch {
      log.warn({ event: 'telegram_price_alerts_failed' }, 'price alert check failed');
    } finally {
      if (locked) await releaseLease(database, 'telegram-price-alerts', holder).catch(() => {});
      checking = false;
    }
  };
  const alertTimer = setInterval(() => void checkAlerts(), 15_000);
  alertTimer.unref();

  // Market events: every minute, one replica records each new event as announced, then messages the chats that want it.
  // Recording first means a restart or a second replica can never send the same event twice.
  let announcing = false;
  const announceEvents = async () => {
    if (announcing) return;
    announcing = true;
    const database = db();
    let locked = false;
    try {
      locked = await acquireLease(database, 'telegram-market-events', holder, 60);
      if (!locked) return;
      const events = await getMarketEvents();
      if (!events.length) return;
      const subs = await database.select().from(telegramEventSubscriptions);
      for (const event of events) {
        const fresh = await database.insert(telegramEventsAnnounced).values({ eventId: event.id }).onConflictDoNothing().returning({ eventId: telegramEventsAnnounced.eventId });
        if (!fresh.length) continue;
        for (const sub of subs) {
          if (!wantsEvent(sub.symbols, event)) continue;
          await reply(env, Number(sub.chatId), event.text).catch(() => log.warn({ event: 'telegram_market_event_send_failed', id: event.id }, 'market event not sent'));
        }
      }
    } catch {
      log.warn({ event: 'telegram_market_events_failed' }, 'market event check failed');
    } finally {
      if (locked) await releaseLease(database, 'telegram-market-events', holder).catch(() => {});
      announcing = false;
    }
  };
  const eventTimer = setInterval(() => void announceEvents(), 60_000);
  eventTimer.unref();

  // Daily LP summary: every 10 minutes, one replica sends each due chat its summary once per New York weekday. The date is
  // recorded before sending, so a restart cannot send a second one the same day. Chats with no shares are skipped quietly.
  let summarising = false;
  const sendDaily = async () => {
    if (summarising) return;
    summarising = true;
    const database = db();
    let locked = false;
    try {
      locked = await acquireLease(database, 'telegram-lp-daily', holder, 120);
      if (!locked) return;
      const subs = await database.select().from(telegramLpDaily);
      const due = subs.filter((s) => dailyDue(Date.now(), s.lastSentYmd).due);
      if (!due.length) return;
      const pool = await lp.getPool();
      for (const sub of due) {
        const { ymd } = dailyDue(Date.now(), sub.lastSentYmd);
        await database.update(telegramLpDaily).set({ lastSentYmd: ymd }).where(eq(telegramLpDaily.chatId, sub.chatId));
        const [link] = await database.select({ wallet: telegramLinks.wallet }).from(telegramLinks).where(eq(telegramLinks.chatId, sub.chatId)).limit(1);
        if (!link) continue;
        const shares = await lp.getShares(link.wallet);
        if (shares === 0n) continue;
        await reply(env, Number(sub.chatId), dailyText(pool, shares)).catch(() => log.warn({ event: 'telegram_lp_daily_send_failed' }, 'daily LP summary not sent'));
      }
    } catch {
      log.warn({ event: 'telegram_lp_daily_failed' }, 'daily LP summary failed');
    } finally {
      if (locked) await releaseLease(database, 'telegram-lp-daily', holder).catch(() => {});
      summarising = false;
    }
  };
  const dailyTimer = setInterval(() => void sendDaily(), 10 * 60_000);
  dailyTimer.unref();
}

export function createTelegramLinkMessage(wallet: string, nonce: string, expires: number): string {
  return `Plankton Telegram link\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}\nExpires: ${expires}`;
}

export async function verifyTelegramLinkSignature(wallet: string, nonce: string, expires: number, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({ address: wallet as Address, message: createTelegramLinkMessage(wallet, nonce, expires), signature: signature as Hex });
  } catch { return false; }
}
