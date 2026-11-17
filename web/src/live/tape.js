// The Tape's market context, shaped for the screen: the runner scanner, the halts board, SEC filings and the catalyst
// calendar, as GET /v1/scanner, /v1/halts, /v1/filings and /v1/catalysts return them. No React here, so it can be tested
// directly. English labels are dictionary keys: the terminal translates them with tr().

export const TAPE_TABS = ['Conditions', 'Scanner', 'Halts', 'Filings', 'Catalysts'];

/** "?tape=scanner" in a link opens that tab. */
export function tapeTabFrom(search) {
  try {
    const value = new URLSearchParams(search).get('tape');
    return TAPE_TABS.find((t) => t.toLowerCase() === String(value ?? '').toLowerCase()) ?? 'Conditions';
  } catch {
    return 'Conditions';
  }
}

export const SCANNER_TAGS = {
  runner: 'Runner',
  fader: 'Fader',
  gap_up: 'Gap up',
  gap_down: 'Gap down',
  high_volume: 'Heavy volume',
  extended_mover: 'Extended-hours move',
  near_52w_high: 'Near 52-week high',
  near_52w_low: 'Near 52-week low',
  low_float: 'Low float',
  halted: 'Halted',
};

/** Tags that call for attention get the warm colour; the rest are neutral. */
export const HOT_SCANNER_TAGS = new Set(['runner', 'gap_up', 'high_volume', 'extended_mover', 'halted']);

export const FILING_TAGS = {
  offering: 'Offering',
  shelf: 'Shelf registration',
  dilution: 'Dilution',
  charter_change: 'Charter change',
  shareholder_vote: 'Shareholder vote',
  listing_notice: 'Listing notice',
  late_filing: 'Late filing',
  delisting: 'Delisting',
  financing: 'Financing',
  earnings: 'Earnings',
  insider_sale: 'Insider sale notice',
  insider_trade: 'Insider trade',
  ownership: 'Large holder',
  report: 'Periodic report',
  event: 'Company update',
};

export const FILING_HINTS = {
  offering: 'New shares are being registered or sold.',
  shelf: 'Registers shares the company can sell later.',
  dilution: 'Shares issued outside a public offering, or registered for employee plans.',
  charter_change: 'Articles or bylaws amended. Reverse stock splits are filed this way.',
  shareholder_vote: 'A shareholder vote. Share increases and reverse splits are proposed in proxies.',
  listing_notice: 'The exchange says a listing rule is not met.',
  late_filing: 'The company says a required report will be late.',
  delisting: 'Removal from the exchange or deregistration.',
  financing: 'A material agreement or new debt, often part of a financing.',
  earnings: 'Quarterly results.',
  insider_sale: 'An insider plans to sell shares.',
};

export const HALT_STATES = { halted: 'Halted', resuming: 'Resumption scheduled', resumed: 'Resumed' };

const EMPTY = '—';

/** +12.3% / −4.0% / — */
export function pct(value, dp = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  const abs = Math.abs(value).toFixed(dp);
  if (Number(abs) === 0) return `${(0).toFixed(dp)}%`;
  return `${value > 0 ? '+' : '−'}${abs}%`;
}

/** 0.64× */
export const times = (value) => (value === null || value === undefined || !Number.isFinite(value) ? EMPTY : `${value.toFixed(2)}×`);

/** Share counts and volumes: 139.5M, 10.4M, 950K. */
export function shares(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

/** Earnings per share: −$0.59, $0.20, — */
export const eps = (value) => (value === null || value === undefined || !Number.isFinite(value) ? EMPTY : `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`);

/** A price with places that suit its level. */
export const price = (value) => (value === null || value === undefined || !Number.isFinite(value) ? EMPTY : value.toFixed(value >= 100 ? 2 : value >= 1 ? 3 : 4));

/** US market times read in New York time, which is how halts and earnings are announced. */
export function easternTime(value, locale = 'en') {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return EMPTY;
  return `${new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)} ET`;
}

/** "2027-03-17" read as a calendar day (no time zone shift). */
export function calendarDay(ymd, locale = 'en') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? ''))) return EMPTY;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Whole days from today (UTC) to a calendar day: 0 today, 1 tomorrow, negative in the past. */
export function daysUntil(ymd, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? ''))) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const today = new Date(now);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86_400_000);
}

export const SCANNER_COLUMNS = [
  { key: 'symbol', label: 'Market', value: (r) => r.symbol },
  { key: 'changePct', label: 'Change', value: (r) => r.changePct },
  { key: 'extended', label: 'Extended hours', value: (r) => r.extended?.changePct ?? null },
  { key: 'gapPct', label: 'Gap', value: (r) => r.gapPct },
  { key: 'relativeVolume', label: 'Volume vs avg', value: (r) => r.relativeVolume },
  { key: 'floatTurnoverPct', label: 'Float turnover', value: (r) => r.floatTurnoverPct },
  { key: 'fromHigh52Pct', label: 'From 52w high', value: (r) => r.fromHigh52Pct },
];

/**
 * Rows sorted by a column. Numbers sort by size ('desc' = biggest first; for change-like columns 'abs' ranks the biggest
 * move either way). Missing values always go last, whichever the direction.
 */
export function sortScanner(rows, key = 'changePct', dir = 'desc') {
  const col = SCANNER_COLUMNS.find((c) => c.key === key) ?? SCANNER_COLUMNS[1];
  const list = [...(rows ?? [])];
  if (col.key === 'symbol') return list.sort((a, b) => (dir === 'asc' ? 1 : -1) * a.symbol.localeCompare(b.symbol));
  const val = (r) => {
    const v = col.value(r);
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return dir === 'abs' ? Math.abs(v) : v;
  };
  return list.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return a.symbol.localeCompare(b.symbol);
    if (x === null) return 1;
    if (y === null) return -1;
    return dir === 'asc' ? x - y : y - x;
  });
}

/** Halts to show, newest first as the API sends them: optionally only our markets, or only those not yet resumed. */
export function visibleHalts(halts, { listedOnly = false, activeOnly = false } = {}) {
  return (halts ?? []).filter((h) => (!listedOnly || h.listed) && (!activeOnly || h.state !== 'resumed'));
}

/** How long a halt lasted, or has lasted so far: "4m", "2h 5m", "3d". */
export function haltDuration(h, now = Date.now()) {
  const end = h.resumesAt !== null && h.resumesAt <= now ? h.resumesAt : now;
  const mins = Math.max(0, Math.round((end - h.startedAt) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.round(mins / 1440)}d`;
}

/** Filings for the list: optional symbol and flagged-only filters, newest first. */
export function visibleFilings(filings, { symbol = 'All', flaggedOnly = false } = {}) {
  return (filings ?? []).filter((f) => (symbol === 'All' || f.symbol === symbol) && (!flaggedOnly || f.importance !== 'low'));
}

/** Upcoming earnings, soonest first, with how many days away. Reports with no upcoming date are left out. */
export function earningsCalendar(earnings, now = Date.now()) {
  return (earnings ?? [])
    .filter((e) => e.next)
    .map((e) => ({ ...e, days: daysUntil(e.next.date, now) }))
    .sort((a, b) => a.next.date.localeCompare(b.next.date) || a.symbol.localeCompare(b.symbol));
}

export const EARNINGS_TIMING = { am: 'Before the open', pm: 'After the close' };

/**
 * Per-market notes for the Conditions list from the context feeds: the newest high-importance filing in the last
 * `filingDays`, and earnings in the next `earningsDays`. Titles and bodies are dictionary keys; `vars` fill their markers.
 */
export function contextEvents({ filings = [], earnings = [], now = Date.now(), filingDays = 7, earningsDays = 7 } = {}) {
  const events = [];
  const recent = now - filingDays * 86_400_000;
  const seen = new Set();
  for (const f of filings) {
    if (f.importance !== 'high' || Date.parse(f.acceptedAt) < recent || seen.has(f.symbol)) continue;
    seen.add(f.symbol); // the newest high-importance filing per market is enough for a card
    const tag = f.tags.find((t) => FILING_HINTS[t]) ?? f.tags[0];
    events.push({ symbol: f.symbol, type: 'Filing', title: FILING_TAGS[tag] ?? 'Company update', body: FILING_HINTS[tag] ?? 'A company filing with the SEC.', form: f.form, link: f.url, at: Date.parse(f.acceptedAt) });
  }
  for (const e of earningsCalendar(earnings, now)) {
    if (e.days === null || e.days < 0 || e.days > earningsDays) continue;
    events.push({
      symbol: e.symbol,
      type: 'Earnings',
      title: e.days === 0 ? 'Earnings today' : e.days === 1 ? 'Earnings tomorrow' : 'Earnings in {days} days',
      vars: { days: e.days },
      body: EARNINGS_TIMING[e.next.timing] ?? 'Release time not stated',
      note: e.next.verified ? null : 'Date not yet confirmed by the company.',
      at: Date.parse(e.next.date),
    });
  }
  return events;
}
