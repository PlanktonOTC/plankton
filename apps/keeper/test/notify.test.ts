import { describe, expect, test } from 'bun:test';
import { fillMessage, notifyFill, type FillNotice } from '../src/notify.ts';

const TX = `0x${'ab'.repeat(32)}` as const;
const base: FillNotice = { kind: 3, symbol: 'RCAT', reducing: true, sizeDeltaE18: -400_000_000_000_000_000n, execPriceE18: 3_421_000_000_000_000_000n, txHash: TX };

/** A stand-in for the one query notifyFill makes: the Telegram link for a wallet. */
const dbWith = (chatId: string | null) =>
  ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => (chatId ? [{ chatId }] : []) }) }) }) }) as never;

describe('fill notices', () => {
  test('a stop-loss that closes a long reads as a close, with price and explorer link', () => {
    expect(fillMessage(base)).toBe(
      `✅ Stop-loss filled · RCAT\nClosed 0.4 RCAT (long) at $3.421\nTx: https://robinhoodchain.blockscout.com/tx/${TX}`,
    );
  });

  test('an entry order reads as an opened long or short', () => {
    expect(fillMessage({ ...base, kind: 0, reducing: false, sizeDeltaE18: 2n * 10n ** 18n })).toContain('Limit order filled · RCAT\nOpened long 2 RCAT');
    expect(fillMessage({ ...base, kind: 4, reducing: false, sizeDeltaE18: -(10n ** 18n) })).toContain('Market order filled · RCAT\nOpened short 1 RCAT');
    expect(fillMessage({ ...base, kind: 2, sizeDeltaE18: 10n ** 18n })).toContain('Take-profit filled · RCAT\nClosed 1 RCAT (short)');
  });

  test('it only sends to a linked chat, and only after the fill confirms on-chain', async () => {
    const sent: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    const common = { token: 't'.repeat(40), trader: '0xABC', notice: base, fetchImpl };

    expect(await notifyFill({ ...common, db: dbWith(null), confirmed: async () => true })).toBe('skipped');
    expect(await notifyFill({ ...common, db: dbWith('42'), confirmed: async () => false })).toBe('skipped');
    expect(await notifyFill({ ...common, token: undefined, db: dbWith('42'), confirmed: async () => true })).toBe('skipped');
    expect(sent).toHaveLength(0);

    expect(await notifyFill({ ...common, db: dbWith('42'), confirmed: async () => true })).toBe('sent');
    expect(sent).toEqual([{ chat_id: 42, text: fillMessage(base), link_preview_options: { is_disabled: true } }]);
  });
});
