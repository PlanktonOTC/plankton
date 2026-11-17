import { describe, expect, test } from 'bun:test';
import {
  classifyFiling,
  filingUrl,
  haltBoard,
  HaltLog,
  HALT_REASONS,
  parseEarnings,
  parseHaltsRss,
  parseSubmissions,
  scannerRow,
  summarizeEarnings,
  type Halt,
} from '../src/index.ts';

// Shapes follow the live Robinhood answers read on 2026-11-17 (RCAT, before the US open).
const FUNDAMENTALS = {
  open: '3.680000',
  high: '3.710000',
  low: '3.510000',
  volume: '10389329.000000',
  average_volume: '6711337.540094',
  average_volume_30_days: '6344435.605630',
  high_52_weeks: '18.780000',
  low_52_weeks: '3.250000',
  float: '139542570.214000',
  market_cap: '538318095.809212',
  market_date: '2026-11-16',
  sector: 'Technology Services',
  industry: 'Packaged Software',
};
const QUOTE = {
  symbol: 'RCAT',
  last_trade_price: '3.525000',
  venue_last_trade_time: '2026-11-16T20:59:59.897844801Z',
  last_non_reg_trade_price: '2.425000',
  venue_last_non_reg_trade_time: '2026-11-17T10:55:22.804003139Z',
  previous_close: '3.800000',
  adjusted_previous_close: '3.800000',
  previous_close_date: '2026-11-13',
  trading_halted: false,
};

describe('runner scanner', () => {
  test('change, gap, range and volume figures come from the latest session', () => {
    const r = scannerRow('RCAT', FUNDAMENTALS, QUOTE);
    expect(r.changePct).toBe(-7.24); // 3.525 vs 3.80
    expect(r.gapPct).toBe(-3.16); // open 3.68 vs 3.80
    expect(r.rangePosition).toBe(0.075); // (3.525 - 3.51) / (3.71 - 3.51)
    expect(r.relativeVolume).toBe(1.64); // 10.39M / 6.34M (30-day average)
    expect(r.floatTurnoverPct).toBe(7.45);
    expect(r.fromHigh52Pct).toBe(-81.23);
    expect(r.marketDate).toBe('2026-11-16');
  });

  test('a pre-market trade newer than the close is the extended move, and a big one is tagged', () => {
    const r = scannerRow('RCAT', FUNDAMENTALS, QUOTE);
    expect(r.extended).toEqual({ price: 2.425, changePct: -31.21, at: QUOTE.venue_last_non_reg_trade_time });
    expect(r.tags).toContain('extended_mover');
    expect(r.tags).not.toContain('near_52w_low'); // 3.525 is more than 3% above the 3.25 low
    expect(scannerRow('RCAT', FUNDAMENTALS, { ...QUOTE, last_trade_price: '3.30' }).tags).toContain('near_52w_low');
  });

  test('an extended trade older than the last regular trade is not shown', () => {
    const r = scannerRow('RCAT', FUNDAMENTALS, { ...QUOTE, venue_last_non_reg_trade_time: '2026-11-16T12:00:00Z' });
    expect(r.extended).toBeNull();
    expect(r.tags).not.toContain('extended_mover');
  });

  test('runners, gappers and heavy volume are tagged by the published thresholds', () => {
    const r = scannerRow('XYZ', { ...FUNDAMENTALS, open: '4.20', high: '4.60', low: '4.10', volume: '20000000', float: '15000000' }, { ...QUOTE, last_trade_price: '4.50', venue_last_non_reg_trade_time: null });
    expect(r.changePct).toBe(18.42);
    expect(r.tags).toEqual(expect.arrayContaining(['runner', 'gap_up', 'high_volume', 'low_float']));
    expect(r.tags).not.toContain('fader');
  });

  test('missing halves give nulls, not guesses', () => {
    const r = scannerRow('NOPE', undefined, undefined);
    expect(r.last).toBeNull();
    expect(r.changePct).toBeNull();
    expect(r.relativeVolume).toBeNull();
    expect(r.tags).toEqual([]);
    expect(scannerRow('RCAT', FUNDAMENTALS, null).changePct).toBeNull();
  });

  test('zero and junk numbers are ignored', () => {
    const r = scannerRow('RCAT', { ...FUNDAMENTALS, average_volume_30_days: '0', average_volume: 'n/a' }, QUOTE);
    expect(r.avgVolume).toBeNull();
    expect(r.relativeVolume).toBeNull();
  });

  test('a halted stock is tagged', () => {
    expect(scannerRow('RCAT', FUNDAMENTALS, { ...QUOTE, trading_halted: true }).tags[0]).toBe('halted');
  });
});

describe('catalyst calendar: earnings', () => {
  const items = parseEarnings({
    results: [
      { symbol: 'RCAT', year: 2026, quarter: 2, eps: { estimate: '-0.180000', actual: '-0.260000' }, report: { date: '2026-08-06', time: '2026-08-06T20:05:00Z', timing: 'pm', verified: true } },
      { symbol: 'RCAT', year: 2026, quarter: 3, eps: { estimate: '-0.180000', actual: '-0.260000' }, report: { date: '2026-11-16', time: '2026-11-16T21:05:00Z', timing: 'pm', verified: true } },
      { symbol: 'RCAT', year: 2026, quarter: 4, eps: { estimate: '-0.130000', actual: null }, report: { date: '2027-03-17', time: '2027-03-17T20:00:00Z', timing: 'pm', verified: false } },
      { symbol: 'RCAT', year: 2027, quarter: 1, eps: { estimate: null, actual: null }, report: null },
    ],
  });

  test('the next report is the first future date without a result, the last is the newest with one', () => {
    const s = summarizeEarnings('RCAT', items, '2026-11-17');
    expect(s.next).toEqual({ year: 2026, quarter: 4, date: '2027-03-17', time: '2027-03-17T20:00:00Z', timing: 'pm', verified: false, epsEstimate: -0.13 });
    expect(s.last).toEqual({ year: 2026, quarter: 3, date: '2026-11-16', epsEstimate: -0.18, epsActual: -0.26, surprisePct: -44.4 });
  });

  test('a report due today still counts as upcoming until its result is in', () => {
    const s = summarizeEarnings('RCAT', items, '2027-03-17');
    expect(s.next?.date).toBe('2027-03-17');
  });

  test('no estimate means no surprise figure; no dates means nothing upcoming', () => {
    const s = summarizeEarnings('X', parseEarnings({ results: [{ symbol: 'X', year: 2026, quarter: 1, eps: { estimate: null, actual: '0.10' }, report: { date: '2026-05-01' } }] }), '2026-11-17');
    expect(s.last?.surprisePct).toBeNull();
    expect(s.next).toBeNull();
    expect(summarizeEarnings('X', [], '2026-11-17')).toEqual({ symbol: 'X', next: null, last: null });
  });
});

describe('SEC filings', () => {
  test('offerings, shelves and dilution are flagged by form', () => {
    expect(classifyFiling('424B5')).toEqual({ tags: ['offering'], importance: 'high' });
    expect(classifyFiling('S-1/A')).toEqual({ tags: ['offering'], importance: 'high' });
    expect(classifyFiling('S-3')).toEqual({ tags: ['shelf'], importance: 'medium' });
    expect(classifyFiling('EFFECT')).toEqual({ tags: ['shelf'], importance: 'medium' });
    expect(classifyFiling('S-8')).toEqual({ tags: ['dilution'], importance: 'medium' });
    expect(classifyFiling('NT 10-Q')).toEqual({ tags: ['late_filing'], importance: 'high' });
    expect(classifyFiling('25-NSE')).toEqual({ tags: ['delisting'], importance: 'high' });
    expect(classifyFiling('144')).toEqual({ tags: ['insider_sale'], importance: 'medium' });
    expect(classifyFiling('4')).toEqual({ tags: ['insider_trade'], importance: 'low' });
    expect(classifyFiling('10-Q')).toEqual({ tags: ['report'], importance: 'low' });
    expect(classifyFiling('SCHEDULE 13D')).toEqual({ tags: ['ownership'], importance: 'medium' });
    expect(classifyFiling('PRE 14A')).toEqual({ tags: ['shareholder_vote'], importance: 'medium' });
  });

  test('an 8-K is read by its items: the most serious one sets the importance', () => {
    expect(classifyFiling('8-K', ['2.02', '9.01'])).toEqual({ tags: ['earnings'], importance: 'medium' });
    expect(classifyFiling('8-K', ['1.01', '3.02', '9.01'])).toEqual({ tags: ['financing', 'dilution'], importance: 'high' });
    expect(classifyFiling('8-K', ['5.03'])).toEqual({ tags: ['charter_change'], importance: 'high' });
    expect(classifyFiling('8-K', ['3.01'])).toEqual({ tags: ['listing_notice'], importance: 'high' });
    expect(classifyFiling('8-K', ['7.01', '9.01'])).toEqual({ tags: ['event'], importance: 'low' });
    expect(classifyFiling('6-K')).toEqual({ tags: ['event'], importance: 'low' });
  });

  test('an unknown form is a plain event, never dropped', () => {
    expect(classifyFiling('CORRESP')).toEqual({ tags: ['event'], importance: 'low' });
  });

  const DOC = {
    cik: '0000748268',
    name: 'Red Cat Holdings, Inc.',
    tickers: ['RCAT'],
    filings: {
      recent: {
        accessionNumber: ['0001628280-26-074175', '0001628280-26-074169', '0001493152-26-048228', 'bad', '0001493152-25-000001'],
        filingDate: ['2026-11-16', '2026-11-16', '2026-10-23', '2026-10-01', '2025-01-02'],
        reportDate: ['2026-09-30', '2026-11-16', '2026-10-21', '', ''],
        acceptanceDateTime: ['2026-11-16T21:08:31.000Z', '2026-11-16T21:06:25.000Z', '2026-10-23T20:05:19.000Z', 'not a time', '2025-01-02T12:00:00.000Z'],
        form: ['10-Q', '8-K', '8-K', '8-K', '424B5'],
        items: ['', '2.02,9.01', '1.01,8.01,9.01', '', ''],
        primaryDocument: ['rcat-20260930.htm', 'rcat-20261116.htm', 'form8-k.htm', 'x.htm', 'p.htm'],
        primaryDocDescription: ['10-Q', '8-K', '', '', ''],
      },
    },
  };

  test('submissions are parsed newest first within the lookback, with links to the documents', () => {
    const out = parseSubmissions(DOC, { sinceMs: Date.UTC(2026, 9, 1), limit: 10 });
    expect(out.cik).toBe(748268);
    expect(out.name).toBe('Red Cat Holdings, Inc.');
    expect(out.filings.map((f) => f.form)).toEqual(['10-Q', '8-K', '8-K']); // the unreadable row and the 2025 filing are left out
    const earnings = out.filings[1]!;
    expect(earnings.items).toEqual(['2.02', '9.01']);
    expect(earnings.tags).toEqual(['earnings']);
    expect(earnings.url).toBe('https://www.sec.gov/Archives/edgar/data/748268/000162828026074169/rcat-20261116.htm');
    expect(out.filings[2]!.description).toBeNull();
  });

  test('the limit caps the list', () => {
    expect(parseSubmissions(DOC, { sinceMs: 0, limit: 2 }).filings).toHaveLength(2);
  });

  test('a document without filings is an error, not an empty list', () => {
    expect(() => parseSubmissions({ cik: 1, name: 'X' }, { sinceMs: 0, limit: 5 })).toThrow();
  });

  test('document links drop the dashes from the accession number', () => {
    expect(filingUrl(1, '0001-26-0002', 'a.htm')).toBe('https://www.sec.gov/Archives/edgar/data/1/0001260002/a.htm');
  });
});

describe('halts board', () => {
  const FEED = `<rss xmlns:ndaq="http://www.nasdaqtrader.com/"><channel>
<item><ndaq:HaltDate>11/16/2026</ndaq:HaltDate><ndaq:HaltTime>19:50:00.000</ndaq:HaltTime><ndaq:IssueSymbol>EDBL</ndaq:IssueSymbol><ndaq:IssueName>Edible Garden AG Inc Cmn</ndaq:IssueName><ndaq:Market>NASDAQ</ndaq:Market><ndaq:ReasonCode>T1</ndaq:ReasonCode><ndaq:PauseThresholdPrice /><ndaq:ResumptionDate /><ndaq:ResumptionQuoteTime /><ndaq:ResumptionTradeTime /></item>
<item><ndaq:HaltDate>11/16/2026</ndaq:HaltDate><ndaq:HaltTime>10:01:02.000</ndaq:HaltTime><ndaq:IssueSymbol>RCAT</ndaq:IssueSymbol><ndaq:IssueName>Red Cat Holdings &amp; Co</ndaq:IssueName><ndaq:Market>NASDAQ</ndaq:Market><ndaq:ReasonCode>LUDP</ndaq:ReasonCode><ndaq:PauseThresholdPrice>3.9512</ndaq:PauseThresholdPrice><ndaq:ResumptionDate>11/16/2026</ndaq:ResumptionDate><ndaq:ResumptionQuoteTime>10:01:02</ndaq:ResumptionQuoteTime><ndaq:ResumptionTradeTime>10:06:02</ndaq:ResumptionTradeTime></item>
</channel></rss>`;
  const halts = parseHaltsRss(FEED);

  test('issue names are decoded and volatility pauses keep their threshold price', () => {
    const r = halts.find((h) => h.symbol === 'RCAT')!;
    expect(r.issueName).toBe('Red Cat Holdings & Co');
    expect(r.pauseThresholdPrice).toBe(3.9512);
    expect(halts.find((h) => h.symbol === 'EDBL')!.pauseThresholdPrice).toBeNull();
  });

  test('rows carry the reason in words, the state and whether we list the stock', () => {
    const now = Date.UTC(2026, 10, 17, 2, 0); // after both halts started (EST, UTC-5)
    const board = haltBoard(halts, new Set(['RCAT']), now);
    expect(board.map((h) => h.symbol)).toEqual(['EDBL', 'RCAT']); // newest first
    expect(board[0]).toMatchObject({ reason: 'News pending', state: 'halted', listed: false });
    expect(board[1]).toMatchObject({ reason: HALT_REASONS.LUDP, state: 'resumed', listed: true });
  });

  test('a published resumption time still ahead reads as resuming', () => {
    const at = Date.UTC(2026, 10, 16, 15, 3); // 10:03 EST, between the pause and its 10:06:02 resumption
    expect(haltBoard(halts, new Set(), at).find((h) => h.symbol === 'RCAT')!.state).toBe('resuming');
  });

  test('a halt that has not started yet is left off; an unknown code shows as itself', () => {
    const future: Halt = { ...halts[0]!, symbol: 'LATER', startedAt: Date.UTC(2030, 0, 1) };
    const odd: Halt = { ...halts[0]!, symbol: 'ODD', reasonCode: 'ZZ9' };
    const board = haltBoard([future, odd], new Set(), Date.UTC(2026, 10, 17, 12));
    expect(board.map((h) => h.symbol)).toEqual(['ODD']);
    expect(board[0]!.reason).toBe('ZZ9');
  });

  test('the log keeps halts that drop off the feed, updates them in place and forgets old ones', () => {
    const log = new HaltLog(3 * 86_400_000);
    const t0 = Date.UTC(2026, 10, 17);
    log.merge(halts, t0);
    log.merge([], t0 + 60_000); // the feed moved on
    expect(log.all()).toHaveLength(2);
    const edbl = halts.find((h) => h.symbol === 'EDBL')!;
    log.merge([{ ...edbl, resumesAt: t0 + 3_600_000 }], t0 + 120_000); // a resumption time is published later
    expect(log.all()).toHaveLength(2);
    expect(log.all().find((h) => h.symbol === 'EDBL')!.resumesAt).toBe(t0 + 3_600_000);
    log.merge([], t0 + 4 * 86_400_000);
    expect(log.all()).toHaveLength(0);
  });

  test('a long halt still on the feed is kept however old it is', () => {
    const log = new HaltLog(3 * 86_400_000);
    const old: Halt = { ...halts[0]!, symbol: 'OLDH', reasonCode: 'H11', startedAt: Date.UTC(2026, 6, 1), resumesAt: null };
    log.merge([old], Date.UTC(2026, 10, 17));
    expect(log.all().map((h) => h.symbol)).toEqual(['OLDH']);
    log.merge([], Date.UTC(2026, 10, 17, 0, 1)); // off the feed: now it ages out
    expect(log.all()).toHaveLength(0);
  });
});
