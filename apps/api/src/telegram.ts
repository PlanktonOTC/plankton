import { createHash, randomBytes } from 'node:crypto';
import { formatUnits, verifyMessage, type Address, type Hex } from 'viem';
import { and, asc, desc, eq, gt, isNull, sql, telegramBotState, telegramChallenges, telegramLinkCodes, telegramLinks, trades, positions, type Db } from '@plankton/db';
import { acquireLease, releaseLease } from '@plankton/db';
import type { Env } from '@plankton/config';

type TelegramUpdate = { update_id: number; message?: { text?: string; chat: { id: number; type: string }; from?: { username?: string } } };
type TelegramResult<T> = { ok: boolean; result: T };

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

const HELP = 'Plankton read-only bot\n/price SYMBOL — current Plankton price\n/prices — latest listed prices\n/positions — your open positions\n/trades — your latest fills\n/unlink — remove this Telegram link\n/help — commands\n\nLink your wallet in Plankton under Account & deposits → Telegram. This bot cannot place trades.';
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

async function handleUpdate(update: TelegramUpdate, env: Env, db: Db, symbols: string[], symbolOf: (marketId: string) => string, getPrices: () => Promise<Map<string, { priceE18: string | null; status: string | null }>>) {
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

export function startTelegramBot({ env, db, symbols, symbolOf, getPrices, log }: {
  env: Env; db: () => Db; symbols: string[]; symbolOf: (marketId: string) => string; getPrices: () => Promise<Map<string, { priceE18: string | null; status: string | null }>>; log: { warn: (data: object, message: string) => void };
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
        try { await handleUpdate(update, env, database, symbols, symbolOf, getPrices); }
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
}

export function createTelegramLinkMessage(wallet: string, nonce: string, expires: number): string {
  return `Plankton Telegram link\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}\nExpires: ${expires}`;
}

export async function verifyTelegramLinkSignature(wallet: string, nonce: string, expires: number, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({ address: wallet as Address, message: createTelegramLinkMessage(wallet, nonce, expires), signature: signature as Hex });
  } catch { return false; }
}
