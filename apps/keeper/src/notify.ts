import { formatUnits, type Hex } from 'viem';
import { eq, telegramLinks, type Db } from '@plankton/db';

const EXPLORER = 'https://robinhoodchain.blockscout.com';
const KIND: Record<number, string> = { 0: 'Limit order', 1: 'Stop order', 2: 'Take-profit', 3: 'Stop-loss', 4: 'Market order' };

const amount = (raw: bigint, places: number) =>
  Number(formatUnits(raw < 0n ? -raw : raw, 18)).toLocaleString('en-US', { maximumFractionDigits: places });

export interface FillNotice {
  kind: number;
  symbol: string;
  /** The order closes (part of) a position rather than opening or adding to one. */
  reducing: boolean;
  sizeDeltaE18: bigint;
  execPriceE18: bigint;
  txHash: Hex;
}

/** The Telegram text for a filled order. Plain text: tickers cannot inject markup. */
export function fillMessage(n: FillNotice): string {
  const side = n.sizeDeltaE18 > 0n ? 'long' : 'short';
  const action = n.reducing
    ? `Closed ${amount(n.sizeDeltaE18, 4)} ${n.symbol} (${n.sizeDeltaE18 > 0n ? 'short' : 'long'})`
    : `Opened ${side} ${amount(n.sizeDeltaE18, 4)} ${n.symbol}`;
  return [
    `✅ ${KIND[n.kind] ?? 'Order'} filled · ${n.symbol}`,
    `${action} at $${amount(n.execPriceE18, 4)}`,
    `Tx: ${EXPLORER}/tx/${n.txHash}`,
  ].join('\n');
}

/**
 * Tells the trader on Telegram, if they linked a chat, once the fill is confirmed on-chain. Never throws into the
 * keeper loop and never logs the token-bearing Telegram URL.
 */
export async function notifyFill(opts: {
  token: string | undefined;
  db: Db;
  trader: string;
  notice: FillNotice;
  confirmed: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}): Promise<'sent' | 'skipped'> {
  if (!opts.token) return 'skipped';
  const [link] = await opts.db.select({ chatId: telegramLinks.chatId }).from(telegramLinks).where(eq(telegramLinks.wallet, opts.trader.toLowerCase())).limit(1);
  if (!link) return 'skipped';
  if (!(await opts.confirmed())) return 'skipped';
  const res = await (opts.fetchImpl ?? fetch)(`https://api.telegram.org/bot${opts.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: Number(link.chatId), text: fillMessage(opts.notice), link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error('Telegram request failed');
  return 'sent';
}
