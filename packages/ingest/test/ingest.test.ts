import { describe, expect, test } from 'bun:test';
import { parseE18 } from '@plankton/core';
import { activeHalts, corporateActionFreeze, parseHaltsRss, rhReading, type RhAsset, type RhCorpAction, type RhQuote } from '../src/index.ts';

const TOKEN = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const dep = { contractAddress: TOKEN, chainId: 4663 };
const asset = (over: Partial<RhAsset> = {}): RhAsset => ({
  tokenSymbol: 'AAPL',
  deployments: [dep],
  currentMultiplier: '1.01',
  pendingMultiplier: '',
  status: 'ASSET_STATUS_ACTIVE',
  ...over,
});
const quote = (over: Partial<RhQuote> = {}): RhQuote => ({
  tokenSymbol: 'AAPL',
  deployments: [dep],
  bid: '100',
  ask: '100.2',
  generatedAt: '2026-10-30T20:33:31.800120987Z',
  tokenBid: '101',
  tokenAsk: '101.202',
  isTradingHalt: false,
  ...over,
});
const read = (a: RhAsset[], q: RhQuote[], token = TOKEN) => rhReading('AAPL', token, 4663, q, a);

describe('Robinhood leg of the mark', () => {
  test('token price is the underlying mid times the multiplier, and it cross-checks against tokenBid/tokenAsk', () => {
    const r = read([asset()], [quote()]);
    expect(r.issues).toEqual([]);
    expect(r.observation!.source).toBe('rh_quote');
    expect(r.observation!.priceE18).toBe(parseE18('101.101'));
    expect(r.observation!.bidE18).toBe(parseE18('101'));
    expect(r.observation!.askE18).toBe(parseE18('101.202'));
    expect(r.observation!.multiplierE18).toBe(parseE18('1.01'));
  });

  test('nanosecond timestamps are read to the millisecond', () => {
    expect(read([asset()], [quote()]).observation!.sourceUpdatedAt).toBe(Date.parse('2026-10-30T20:33:31.800Z'));
  });

  test('a token at a different address is an impostor and gives no price', () => {
    const r = read([asset()], [quote()], '0x0000000000000000000000000000000000000001');
    expect(r.observation).toBeNull();
    expect(r.issues).toContain('wrong_contract');
  });

  test('address matching ignores letter case', () => {
    expect(read([asset()], [quote()], TOKEN.toLowerCase()).issues).toEqual([]);
  });

  test('an unknown or inactive asset gives no price', () => {
    expect(read([], [quote()]).issues).toContain('asset_missing');
    expect(read([asset({ status: 'ASSET_STATUS_PAUSED' })], [quote()]).issues).toContain('asset_inactive');
    expect(read([asset()], []).observation).toBeNull();
  });

  test('a pending multiplier is flagged (the market freezes) but the price is still read', () => {
    const r = read([asset({ pendingMultiplier: '2.02' })], [quote()]);
    expect(r.issues).toEqual(['pending_multiplier']);
    expect(r.observation).not.toBeNull();
  });

  test('a pending multiplier equal to the current one is not a change', () => {
    expect(read([asset({ pendingMultiplier: '1.01' })], [quote()]).issues).toEqual([]);
  });

  test('if our multiplier maths disagrees with Robinhood\'s own token prices the source is dropped', () => {
    const r = read([asset()], [quote({ tokenBid: '102.5', tokenAsk: '102.7' })]); // ~1.4% off
    expect(r.observation).toBeNull();
    expect(r.issues).toContain('multiplier_mismatch');
  });

  test('a crossed or zero quote is refused', () => {
    expect(read([asset()], [quote({ bid: '101', ask: '100' })]).issues).toContain('bad_quote');
    expect(read([asset()], [quote({ bid: '0', ask: '0', tokenBid: undefined, tokenAsk: undefined })]).issues).toContain('bad_quote');
    expect(read([asset()], [quote({ bid: 'abc' })]).issues).toContain('bad_quote');
  });

  test('Robinhood\'s halt flag is passed through', () => {
    expect(read([asset()], [quote({ isTradingHalt: true })]).halted).toBe(true);
  });
});

describe('corporate actions', () => {
  const NOW = Date.UTC(2026, 10, 20, 12);
  const action = (over: Partial<RhCorpAction>): RhCorpAction => ({
    id: '0x1',
    type: 'CORPORATE_ACTION_TYPE_STOCK_SPLIT',
    status: 'CORPORATE_ACTION_STATUS_IN_PROGRESS',
    tokenSymbol: 'AAPL',
    processDate: { year: 2026, month: 11, day: 20 },
    ...over,
  });

  test('a split being processed around now freezes the market', () => {
    expect(corporateActionFreeze([action({})], 'AAPL', NOW)).toBe(true);
  });
  test('a split a month away does not', () => {
    expect(corporateActionFreeze([action({ processDate: { year: 2026, month: 12, day: 25 } })], 'AAPL', NOW)).toBe(false);
  });
  test('cash dividends do not freeze (they show up as a pending multiplier instead)', () => {
    expect(corporateActionFreeze([action({ type: 'CORPORATE_ACTION_TYPE_CASH_DIVIDEND' })], 'AAPL', NOW)).toBe(false);
  });
  test('completed actions and other tickers do not', () => {
    expect(corporateActionFreeze([action({ status: 'CORPORATE_ACTION_STATUS_COMPLETED' })], 'AAPL', NOW)).toBe(false);
    expect(corporateActionFreeze([action({ tokenSymbol: 'MSFT' })], 'AAPL', NOW)).toBe(false);
  });
  test('an action with no date is treated as live', () => {
    expect(corporateActionFreeze([action({ processDate: undefined })], 'AAPL', NOW)).toBe(true);
  });
});

// Taken from the live Nasdaq Trader feed on 2026-10-30 (BOM and namespace included).
const FEED = `﻿<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/"><channel><title>NASDAQTrader.com</title>
<item><title>DGICB</title><ndaq:HaltDate>10/30/2026</ndaq:HaltDate><ndaq:HaltTime>15:58:45.050</ndaq:HaltTime><ndaq:IssueSymbol>DGICB</ndaq:IssueSymbol><ndaq:IssueName>Donegal Group Inc Cl B</ndaq:IssueName><ndaq:Market>NASDAQ</ndaq:Market><ndaq:ReasonCode>LUDP</ndaq:ReasonCode><ndaq:PauseThresholdPrice /><ndaq:ResumptionDate>10/30/2026</ndaq:ResumptionDate><ndaq:ResumptionQuoteTime>15:58:45</ndaq:ResumptionQuoteTime><ndaq:ResumptionTradeTime>16:00:00</ndaq:ResumptionTradeTime></item>
<item><title>ASPE</title><ndaq:HaltDate>10/30/2026</ndaq:HaltDate><ndaq:HaltTime>10:15:00.000</ndaq:HaltTime><ndaq:IssueSymbol>ASPE</ndaq:IssueSymbol><ndaq:Market>NASDAQ</ndaq:Market><ndaq:ReasonCode>T1</ndaq:ReasonCode><ndaq:PauseThresholdPrice /><ndaq:ResumptionDate /><ndaq:ResumptionQuoteTime /><ndaq:ResumptionTradeTime /></item>
<item><title>BAD</title><ndaq:HaltDate>not a date</ndaq:HaltDate><ndaq:HaltTime>10:15:00.000</ndaq:HaltTime><ndaq:IssueSymbol>BAD</ndaq:IssueSymbol><ndaq:ReasonCode>T1</ndaq:ReasonCode></item>
</channel></rss>`;

describe('Nasdaq halts feed', () => {
  const halts = parseHaltsRss(FEED);

  test('parses items, reading Eastern times in summer time', () => {
    const d = halts.find((h) => h.symbol === 'DGICB')!;
    expect(d.reasonCode).toBe('LUDP');
    expect(d.startedAt).toBe(Date.UTC(2026, 9, 30, 19, 58, 45, 50)); // 15:58:45.050 EDT
    expect(d.resumesAt).toBe(Date.UTC(2026, 9, 30, 20, 0, 0)); // 16:00:00 EDT
  });

  test('an open-ended halt has no resumption time', () => {
    expect(halts.find((h) => h.symbol === 'ASPE')!.resumesAt).toBeNull();
  });

  test('an item with an unreadable date is skipped, not guessed', () => {
    expect(halts.find((h) => h.symbol === 'BAD')).toBeUndefined();
    expect(halts).toHaveLength(2);
  });

  test('a short pause is active until its resumption time, an open halt stays active', () => {
    expect(activeHalts(halts, Date.UTC(2026, 9, 30, 19, 59)).has('DGICB')).toBe(true);
    expect(activeHalts(halts, Date.UTC(2026, 9, 30, 20, 0, 0)).has('DGICB')).toBe(false); // resumed exactly now
    expect(activeHalts(halts, Date.UTC(2026, 9, 30, 21, 0)).has('ASPE')).toBe(true);
  });

  test('a halt that has not started yet is not active', () => {
    expect(activeHalts(halts, Date.UTC(2026, 9, 30, 12, 0)).has('ASPE')).toBe(false); // starts 10:15 EDT = 14:15Z
  });

  test('an empty or broken feed gives no halts rather than an error', () => {
    expect(parseHaltsRss('')).toEqual([]);
    expect(parseHaltsRss('<html>maintenance</html>')).toEqual([]);
  });
});
