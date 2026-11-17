import React, { useMemo, useState } from 'react';
import { useTerminal } from './shared.jsx';
import { useCatalysts, useFilings, useHalts, useScanner } from '../live/queries.js';
import { relativeTime } from '../live/model.js';
import {
  EARNINGS_TIMING,
  FILING_HINTS,
  FILING_TAGS,
  HALT_STATES,
  HOT_SCANNER_TAGS,
  SCANNER_COLUMNS,
  SCANNER_TAGS,
  calendarDay,
  earningsCalendar,
  easternTime,
  eps,
  haltDuration,
  pct,
  price,
  shares,
  sortScanner,
  times,
  visibleFilings,
  visibleHalts,
} from '../live/tape.js';
import { useI18n } from '../i18n';

// The Tape's context panels: the runner scanner, the halts board, SEC filings and the catalyst calendar. Each reads its
// own public API route (see apps/api/src/tape.ts) and polls only while the Tape is open.

const tone = (v) => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'term-positive' : 'term-negative');

function Status({ query, every }) {
  const { t: tr } = useI18n();
  const updated = query.data?.updatedAt;
  return (
    <span className={`term-small-badge ${query.data ? '' : 'is-off'}`}>
      {tr(query.data ? every : query.isError ? 'UNAVAILABLE' : 'LOADING')}
      {updated ? <> · {tr(relativeTime(Date.parse(updated)))}</> : null}
    </span>
  );
}

function Problem({ query, what }) {
  const { t: tr } = useI18n();
  if (!query.isError) return null;
  return <div className="term-info-banner" role="status">{tr(query.data ? 'Showing the last good data. {what} could not be refreshed.' : '{what} is unavailable right now.', { what: tr(what) })} {tr('It reloads on its own.')}</div>;
}

function MarketCell({ symbol, name, listed = true }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  if (!listed) return <><strong>{symbol}</strong>{name ? <small>{name}</small> : null}</>;
  return (
    <button type="button" className="term-tape-market" onClick={() => t.chooseMarket(symbol)} aria-label={tr('Open {symbol} in the trade view', { symbol })}>
      <strong>{symbol}</strong>{name ? <small>{name}</small> : null}
    </button>
  );
}

// ---------------------------------------------------------------- runner scanner

export function ScannerPanel({ active, markets }) {
  const { t: tr, lang } = useI18n();
  const query = useScanner(active);
  const [sort, setSort] = useState({ key: 'changePct', dir: 'abs' });
  const names = useMemo(() => new Map(markets.map((m) => [m.symbol, m.name])), [markets]);
  const rows = useMemo(() => sortScanner(query.data?.rows, sort.key, sort.dir), [query.data, sort]);
  const marketDate = query.data?.rows.find((r) => r.marketDate)?.marketDate;
  const next = (key) => {
    if (key === 'symbol') return setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
    // A move column ranks the biggest move either way first, then up moves, then down moves.
    const moves = ['changePct', 'extended', 'gapPct'];
    const cycle = moves.includes(key) ? ['abs', 'desc', 'asc'] : ['desc', 'asc'];
    setSort((s) => ({ key, dir: s.key === key ? cycle[(cycle.indexOf(s.dir) + 1) % cycle.length] : cycle[0] }));
  };
  const arrow = (key) => (sort.key !== key ? '' : sort.dir === 'abs' ? ' ↕' : sort.dir === 'asc' ? ' ↑' : ' ↓');
  const ariaSort = (key) => (sort.key !== key ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending');
  return (
    <div className="term-large-panel term-tape-panel">
      <h2>{tr('Runner scanner')} <Status query={query} every="LIVE · 30S" /></h2>
      <p>{tr('How each listed stock is trading in its latest session: the move, the opening gap, any pre-market or after-hours trade, and volume against its 30-day average.')}{marketDate ? <> {tr('Session: {date}.', { date: calendarDay(marketDate, lang) })}</> : null}</p>
      <Problem query={query} what="The scanner" />
      {rows.length ? (
        <div className="term-table-wrap"><table className="term-scanner-table"><thead><tr>
          {SCANNER_COLUMNS.map((c) => <th key={c.key} aria-sort={ariaSort(c.key)}><button type="button" className="term-sort-btn" onClick={() => next(c.key)}>{tr(c.label, null, 'scanner')}{arrow(c.key)}</button></th>)}
          <th>{tr('Last')}</th><th>{tr('Day range')}</th><th>{tr('Float')}</th><th>{tr('Signals')}</th>
        </tr></thead><tbody>
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td><MarketCell symbol={r.symbol} name={names.get(r.symbol)} /></td>
              <td className={tone(r.changePct)}><strong>{pct(r.changePct)}</strong></td>
              <td className={tone(r.extended?.changePct)}>{r.extended ? <>{pct(r.extended.changePct)}<small>${price(r.extended.price)}</small></> : '—'}</td>
              <td className={tone(r.gapPct)}>{pct(r.gapPct)}</td>
              <td className={r.relativeVolume >= 2 ? 'term-tape-hot' : ''}>{times(r.relativeVolume)}<small>{shares(r.volume)}</small></td>
              <td>{r.floatTurnoverPct === null ? '—' : `${r.floatTurnoverPct.toFixed(1)}%`}</td>
              <td>{pct(r.fromHigh52Pct, 0)}</td>
              <td>${price(r.last)}<small>{tr('prev ${price}', { price: price(r.previousClose) })}</small></td>
              <td><span className="term-range" title={`$${price(r.low)} – $${price(r.high)}`}><i style={{ left: `${Math.round((r.rangePosition ?? 0) * 100)}%` }} hidden={r.rangePosition === null} /></span><small>${price(r.low)} – ${price(r.high)}</small></td>
              <td>{shares(r.float)}</td>
              <td><span className="term-tape-tags">{r.tags.length ? r.tags.map((tag) => <span key={tag} className={`term-tape-tag ${HOT_SCANNER_TAGS.has(tag) ? 'is-hot' : ''}`}>{tr(SCANNER_TAGS[tag] ?? tag)}</span>) : <small>—</small>}</span></td>
            </tr>
          ))}
        </tbody></table></div>
      ) : <div className="term-empty">{tr(query.isLoading ? 'Loading the scanner…' : 'No scanner figures yet.')}</div>}
      <p className="term-fineprint">{tr('Figures describe the underlying stock, not the on-chain mark, from Robinhood’s public market data. Volume against the average is not adjusted for the time of day, so it starts low each morning. Signals: runner +10% or more, fader −10% or more, gap ±5%, heavy volume at 2× the average, extended-hours move ±5%, within 3% of the 52-week high or low, float under 20M shares.')}</p>
    </div>
  );
}

// ---------------------------------------------------------------- halts board

export function HaltsPanel({ active }) {
  const { t: tr, lang } = useI18n();
  const query = useHalts(active);
  const [listedOnly, setListedOnly] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const all = query.data?.halts ?? [];
  const rows = visibleHalts(all, { listedOnly, activeOnly });
  const now = Date.now();
  const stillHalted = all.filter((h) => h.state !== 'resumed').length;
  return (
    <div className="term-large-panel term-tape-panel">
      <h2>{tr('Trading halts')} <Status query={query} every="LIVE · 30S" /></h2>
      <p>{tr('Halts in every US-listed stock from Nasdaq’s trade-halt feed, newest first. A halt on one of our markets stops new positions and liquidations; closing stays available.')}</p>
      <Problem query={query} what="The halts board" />
      <div className="term-tape-filters">
        <div className="term-inline-tabs" role="group" aria-label={tr('Which halts')}>
          {[['All US halts', false], ['Our markets', true]].map(([label, value]) => <button key={label} type="button" className={listedOnly === value ? 'active' : ''} aria-pressed={listedOnly === value} onClick={() => setListedOnly(value)}>{tr(label)}</button>)}
        </div>
        <label className="term-tape-check"><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> {tr('Still halted only')} <small>{stillHalted}</small></label>
      </div>
      {rows.length ? (
        <div className="term-table-wrap"><table><thead><tr><th>{tr('Stock')}</th><th>{tr('Reason')}</th><th>{tr('Halted', null, 'tape-column')}</th><th>{tr('Status')}</th><th>{tr('Duration')}</th></tr></thead><tbody>
          {rows.map((h) => (
            <tr key={`${h.symbol}-${h.startedAt}-${h.reasonCode}`} className={h.listed ? 'term-tape-listed' : ''}>
              <td><MarketCell symbol={h.symbol} name={h.issueName} listed={h.listed} />{h.listed ? <span className="term-tape-tag is-hot">{tr('ON PLANKTON')}</span> : null}</td>
              <td><strong>{tr(h.reason)}</strong><small>{h.reasonCode}{h.pauseThresholdPrice ? ` · ${tr('band ${price}', { price: price(h.pauseThresholdPrice) })}` : ''}</small></td>
              <td>{easternTime(h.startedAt, lang)}<small>{h.market}</small></td>
              <td className={h.state === 'resumed' ? '' : 'term-tape-hot'}>{tr(HALT_STATES[h.state] ?? h.state)}{h.resumesAt ? <small>{easternTime(h.resumesAt, lang)}</small> : null}</td>
              <td>{haltDuration(h, now)}</td>
            </tr>
          ))}
        </tbody></table></div>
      ) : <div className="term-empty">{tr(query.isLoading ? 'Loading halts…' : listedOnly ? 'None of our markets has been halted in the last three days.' : 'No halts in the current window.')}</div>}
      <p className="term-fineprint">{tr('Times are New York time. Halts stay listed for three days after they start, longer while still in force. Reason codes are Nasdaq’s; a volatility pause shows the price band that triggered it.')}</p>
    </div>
  );
}

// ---------------------------------------------------------------- SEC filings

export function FilingsPanel({ active, markets }) {
  const { t: tr, lang } = useI18n();
  const query = useFilings(active);
  const [symbol, setSymbol] = useState('All');
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const all = query.data?.filings ?? [];
  const rows = visibleFilings(all, { symbol, flaggedOnly });
  const symbols = useMemo(() => [...new Set(all.map((f) => f.symbol))].sort(), [all]);
  const names = useMemo(() => new Map(markets.map((m) => [m.symbol, m.name])), [markets]);
  return (
    <div className="term-large-panel term-tape-panel">
      <h2>{tr('SEC filings')} <Status query={query} every="EDGAR · 10 MIN" /></h2>
      <p>{tr('Recent filings for every listed company, tagged so offerings, shelf registrations, dilution, charter changes and listing notices stand out.')}</p>
      <Problem query={query} what="The filings feed" />
      <div className="term-tape-filters">
        <label className="term-tape-select">{tr('Company')} <select value={symbol} onChange={(e) => setSymbol(e.target.value)}><option value="All">{tr('All markets')}</option>{symbols.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label className="term-tape-check"><input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} /> {tr('Flagged filings only')}</label>
      </div>
      {rows.length ? rows.map((f) => {
        const main = f.tags.find((tag) => FILING_HINTS[tag]) ?? f.tags[0];
        return (
          <article className={`term-tape-filing is-${f.importance}`} key={f.accession}>
            <div className="term-tape-filing-head">
              <MarketCell symbol={f.symbol} name={names.get(f.symbol) ?? f.company} />
              <span className="term-tape-form">{f.form}{f.items.length ? ` · ${tr('items {items}', { items: f.items.join(', ') })}` : ''}</span>
              <time dateTime={f.acceptedAt} title={easternTime(f.acceptedAt, lang)}>{tr(relativeTime(Date.parse(f.acceptedAt)))}</time>
            </div>
            <span className="term-tape-tags">{f.tags.map((tag) => <span key={tag} className={`term-tape-tag ${f.importance === 'high' ? 'is-hot' : ''}`}>{tr(FILING_TAGS[tag] ?? tag)}</span>)}</span>
            {FILING_HINTS[main] ? <p>{tr(FILING_HINTS[main])}</p> : null}
            {f.description && f.description !== f.form ? <p className="term-tape-desc">{f.description}</p> : null}
            <a href={f.url} target="_blank" rel="noreferrer">{tr('Read the filing on SEC.gov')} ↗</a>
          </article>
        );
      }) : <div className="term-empty">{tr(query.isLoading ? 'Loading filings…' : flaggedOnly ? 'No flagged filings in this window.' : 'No filings in this window.')}</div>}
      <p className="term-fineprint">{tr('From SEC EDGAR, the last {days} days, refreshed every 10 minutes. Tags come from the form type and 8-K item numbers: they point at a filing worth reading, they do not summarise it.', { days: query.data?.lookbackDays ?? 45 })}</p>
    </div>
  );
}

// ---------------------------------------------------------------- catalyst calendar

export function CatalystsPanel({ active, markets }) {
  const { t: tr, lang } = useI18n();
  const query = useCatalysts(active);
  const rows = earningsCalendar(query.data?.earnings);
  const names = useMemo(() => new Map(markets.map((m) => [m.symbol, m.name])), [markets]);
  const actions = query.data?.corporateActions ?? [];
  const when = (days) => (days === 0 ? tr('Today') : days === 1 ? tr('Tomorrow') : tr('In {days} days', { days }));
  return (
    <div className="term-large-panel term-tape-panel">
      <h2>{tr('Catalyst calendar')} <Status query={query} every="EVERY 3H" /></h2>
      <p>{tr('The next earnings report for every listed company, soonest first, beside the last quarter’s result. Unconfirmed dates are estimates until the company announces them.')}</p>
      <Problem query={query} what="The catalyst calendar" />
      {rows.length ? (
        <div className="term-table-wrap"><table><thead><tr><th>{tr('Market')}</th><th>{tr('Next report')}</th><th>{tr('When')}</th><th>{tr('EPS estimate')}</th><th>{tr('Last quarter')}</th><th>{tr('Surprise')}</th></tr></thead><tbody>
          {rows.map((e) => (
            <tr key={e.symbol}>
              <td><MarketCell symbol={e.symbol} name={names.get(e.symbol)} /></td>
              <td><strong>{calendarDay(e.next.date, lang)}</strong><small>{e.days >= 0 ? when(e.days) : ''}{e.next.verified ? '' : ` · ${tr('unconfirmed')}`}</small></td>
              <td>{tr(EARNINGS_TIMING[e.next.timing] ?? 'Release time not stated')}<small>Q{e.next.quarter} {e.next.year}</small></td>
              <td>{eps(e.next.epsEstimate)}</td>
              <td>{e.last ? <>{eps(e.last.epsActual)}<small>{e.last.epsEstimate === null ? tr('no estimate · {date}', { date: calendarDay(e.last.date, lang) }) : tr('vs {estimate} est. · {date}', { estimate: eps(e.last.epsEstimate), date: calendarDay(e.last.date, lang) })}</small></> : '—'}</td>
              <td className={tone(e.last?.surprisePct)}>{e.last ? pct(e.last.surprisePct) : '—'}</td>
            </tr>
          ))}
        </tbody></table></div>
      ) : <div className="term-empty">{tr(query.isLoading ? 'Loading the calendar…' : 'No upcoming reports published yet.')}</div>}
      <h3 className="term-tape-subhead">{tr('Corporate actions')}</h3>
      {actions.length ? (
        <div className="term-table-wrap"><table><thead><tr><th>{tr('Market')}</th><th>{tr('Action')}</th><th>{tr('Date')}</th><th>{tr('Status')}</th></tr></thead><tbody>
          {actions.map((a) => <tr key={a.id}><td><MarketCell symbol={a.symbol} name={names.get(a.symbol)} /></td><td>{tr(a.type.replace(/_/g, ' '))}</td><td>{calendarDay(a.processDate, lang)}</td><td>{tr(a.status.replace(/_/g, ' '))}</td></tr>)}
        </tbody></table></div>
      ) : <div className="term-empty">{tr('No Stock Token corporate actions are scheduled for our markets.')}<small>{tr('Splits and other actions freeze a market for new positions around the processing date.')}</small></div>}
      <p className="term-fineprint">{tr('Earnings dates and estimates from Robinhood’s public market data; corporate actions from the Stock Token issuer’s feed. EPS is per share in US dollars.')}</p>
    </div>
  );
}
