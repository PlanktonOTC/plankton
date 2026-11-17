import React, { useEffect, useRef, useState } from 'react';
import { parseEventLogs, zeroAddress } from 'viem';
import { usePublicClient, useReadContract } from 'wagmi';
import { Arrow, TxProgress, useStored, useTerminal } from './shared.jsx';
import { useCatalysts, useCounter, useCounterHistory, useFilings, useLedger, useLeaderboard } from '../live/queries.js';
import { TAPE_TABS, contextEvents, tapeTabFrom } from '../live/tape.js';
import { CatalystsPanel, FilingsPanel, HaltsPanel, ScannerPanel } from './Tape.jsx';
import { relativeTime } from '../live/model.js';
import { counterDeposit, counterWithdraw } from '../live/trade.js';
import { vaultAbi } from '../live/abis.js';
import { explorerAddress, explorerTx } from '../live/wagmi.js';
import { big, formatUnits, money, parseUnits, parseUsdg, shortAddress, usdgNum } from '../live/units.js';
import { useI18n } from '../i18n';

const SHARE_DECIMALS = 9;
const usd0 = (v) => `$${money(usdgNum(v), 0)}`;
const usd2 = (v) => `$${money(usdgNum(v))}`;

function CounterNavChart({ snapshots, currentAt, currentNavPerShareE18, tr }) {
  const rows = [...(snapshots ?? [])].map((row) => ({ at: new Date(row.at).getTime(), price: Number(row.navPerShareE18) / 1e15 }));
  if (currentAt && currentNavPerShareE18) rows.push({ at: new Date(currentAt).getTime(), price: Number(currentNavPerShareE18) / 1e15 });
  if (rows.length < 2) return <div className="term-empty">{tr('Hourly share-price snapshots will build this chart over time.')}</div>;
  const min = rows.reduce((v, row) => Math.min(v, row.price), Infinity);
  const max = rows.reduce((v, row) => Math.max(v, row.price), -Infinity);
  const span = max - min || Math.abs(max) * 0.001 || 0.001;
  const firstAt = rows[0].at;
  const elapsed = rows.at(-1).at - firstAt || 1;
  const points = rows.map((row, i) => `${18 + ((row.at - firstAt) / elapsed) * 644},${142 - ((row.price - min) / span) * 124}`).join(' ');
  return (
    <div className="term-counter-chart-wrap">
      <svg viewBox="0 0 680 160" role="img" aria-label={tr('Counter share price history')}>
        <title>{tr('Counter share price history')}</title>
        <path d="M18 18H662 M18 80H662 M18 142H662" className="term-counter-chart-grid" />
        <polyline points={points} className="term-counter-chart-line" />
      </svg>
      <div><span>{new Date(firstAt).toLocaleDateString()}</span><span>{new Date(rows.at(-1).at).toLocaleDateString()}</span></div>
    </div>
  );
}

function aprLabel(bps, tr, days) {
  return bps === null || bps === undefined
    ? tr('Building {days}-day history', { days })
    : `${bps > 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`;
}

function signedUsdg(value) {
  const amount = usdgNum(value);
  return amount === 0 ? '$0.00' : `${amount > 0 ? '+' : '−'}$${money(Math.abs(amount))}`;
}

function CounterRequestWatcher({ request, vault, onSettled, onPartial }) {
  const query = useReadContract({
    address: vault || zeroAddress,
    abi: vaultAbi,
    functionName: 'requests',
    args: [BigInt(request.requestId)],
    query: { enabled: Boolean(vault && request.requestId), refetchInterval: 15_000 },
  });
  const row = query.data;
  const done = row?.done ?? row?.[2] ?? false;
  const filled = String(row?.filled ?? row?.[5] ?? 0n);
  useEffect(() => {
    if (done && request.status !== 'settled') onSettled(request.key);
    else if (request.action === 'Withdraw' && BigInt(filled) > BigInt(request.observedFilled || '0')) onPartial(request.key, filled);
  }, [done, filled, onPartial, onSettled, request.action, request.key, request.observedFilled, request.status]);
  return null;
}

function Unavailable({ what, error }) {
  const { t: tr } = useI18n();
  return <div className="term-info-banner" role="status">{tr(`${what} is unavailable right now${error?.status === 503 ? ': the exchange contracts are not reachable.' : '.'}`)} {tr('It reloads on its own.')}</div>;
}

// ---------------------------------------------------------------- the Counter

export function CounterView({ account, contracts }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const counter = useCounter();
  const history = useCounterHistory();
  const ledger = useLedger();
  const publicClient = usePublicClient();
  const c = counter.data;
  const [action, setAction] = useState('Deposit');
  const [amount, setAmount] = useState('100');
  const [error, setError] = useState('');
  const [requests, setRequests] = useStored('plankton.counter.requests', []);
  const notified = useRef(new Set());
  const connected = t.wallet.isConnected;
  const trackedRequests = Array.isArray(requests) ? requests : [];
  const visibleRequests = trackedRequests.filter((request) => request.owner === t.wallet.address?.toLowerCase());

  function markSettled(key) {
    const request = trackedRequests.find((item) => item.key === key);
    const notificationKey = `${key}:settled`;
    if (!request || notified.current.has(notificationKey)) return;
    notified.current.add(notificationKey);
    setRequests((prev) => Array.isArray(prev) ? prev.map((item) => item.key === key ? { ...item, status: 'settled' } : item) : prev);
    t.notify(request.action === 'Deposit'
      ? 'Your Counter deposit request has settled on-chain.'
      : 'Your Counter withdrawal request has settled on-chain.');
  }

  function markPartial(key, filled) {
    const notificationKey = `${key}:filled:${filled}`;
    if (notified.current.has(notificationKey)) return;
    notified.current.add(notificationKey);
    setRequests((prev) => Array.isArray(prev) ? prev.map((item) => item.key === key ? { ...item, status: 'partial', observedFilled: filled } : item) : prev);
    t.notify('Your Counter withdrawal request has a partial on-chain fill. The remaining shares are still queued.');
  }

  async function request(event) {
    event.preventDefault();
    setError('');
    if (!connected) return t.openWallet();
    const isDeposit = action === 'Deposit';
    const value = isDeposit ? parseUsdg(amount) : parseUnits(amount, SHARE_DECIMALS);
    const requestAction = isDeposit ? 'Deposit' : 'Withdraw';
    if (value === null || value <= 0n) return setError('Enter an amount above 0.');
    if (isDeposit && usdgNum(value) > account.wallet + 1e-9) return setError(`Your wallet holds ${money(account.wallet)} USDG.`);
    if (!isDeposit && value > account.shares) return setError(`You hold ${formatUnits(account.shares, SHARE_DECIMALS, 4)} Counter shares.`);
    const result = await t.trader.run((ctx) => (isDeposit ? counterDeposit(ctx, value) : counterWithdraw(ctx, value)));
    if (result.ok) {
      let requestId = '';
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: result.hash });
        const eventName = isDeposit ? 'DepositRequested' : 'WithdrawRequested';
        const logs = parseEventLogs({ abi: vaultAbi, eventName, logs: receipt.logs, strict: false });
        const event = logs.find((log) => log.address.toLowerCase() === contracts?.vault?.toLowerCase()
          && log.args.owner?.toLowerCase() === t.wallet.address?.toLowerCase());
        if (event) requestId = String(event.args.id);
      } catch { /* Keep the transaction visible if this RPC cannot return its receipt logs. */ }
      const key = requestId ? `${t.wallet.address?.toLowerCase()}:${requestId}` : `tx:${result.hash}`;
      setRequests((prev) => [{ key, requestId, owner: t.wallet.address?.toLowerCase(), action: requestAction, text: isDeposit ? `${money(usdgNum(value))} USDG` : `${formatUnits(value, SHARE_DECIMALS, 4)} shares`, hash: result.hash, at: Date.now(), status: requestId ? 'pending' : 'untracked' }, ...(Array.isArray(prev) ? prev : [])].slice(0, 50));
      t.notify(`${requestAction} requested. It settles after the next mark, at the worse of two prices.`);
    } else setError(result.message);
  }

  const stats = c
    ? [['Counter NAV', usd2(c.navUsdg), 'Pool value after trader PnL'], ['Free cash', usd2(c.freeCashUsdg), 'Not backing positions or payouts'], ['Backstop Fund', usd2(c.backstopUsdg), `Target ${usd0(c.backstopTargetUsdg)}`], ['First-Loss tranche', usd2(c.firstLossUsdg), 'Junior capital ahead of LPs']]
    : [['Counter NAV', '—', ''], ['Free cash', '—', ''], ['Backstop Fund', '—', ''], ['First-Loss tranche', '—', '']];
  const oldest = c ? Number(big(c.oldestPendingWithdrawAgeSec)) : 0;
  const activity = history.data?.activityReady ? history.data.contributors30d : null;
  const exposureRows = ledger.data?.markets ?? [];
  const maxGrossOi = exposureRows.reduce((max, row) => Math.max(max, usdgNum(big(row.longOiUsdg) + big(row.shortOiUsdg))), 0);

  return (
    <section className="term-secondary-view">
      <div className="term-view-title">
        <div><p className="term-overline">{tr('THE COUNTER · LIQUIDITY POOL')}</p><h1>{tr('One pool. A visible risk budget.')}</h1><p>{tr('The Counter is the other side of every trade. Liquidity providers can lose capital. All figures below are read from the contracts.')}</p></div>
        <span className={`term-small-badge ${c ? '' : 'is-off'}`}>{tr(c ? 'LIVE' : counter.isError ? 'UNAVAILABLE' : 'LOADING')}</span>
      </div>
      {counter.isError && !c && <Unavailable what="The Counter" error={counter.error} />}
      <div className="term-stat-grid">{stats.map(([label, value, note]) => <div key={label}><span>{tr(label)}</span><strong>{value}</strong><small>{tr(note)}</small></div>)}</div>
      <div className="term-counter-analytics">
        <section className="term-large-panel term-counter-performance">
          <div className="term-counter-section-heading"><div><span className="term-overline">{tr('FLOW-ADJUSTED SHARE RETURN')}</span><h2>{tr('Counter APR history')}</h2></div><span className={`term-small-badge ${history.data ? '' : 'is-off'}`}>{tr(history.data ? 'HOURLY · ON-CHAIN' : history.isError ? 'UNAVAILABLE' : 'COLLECTING')}</span></div>
          <p>{tr('Annualized change in NAV per Counter share. Deposits and withdrawals do not count as return.')}</p>
          <div className="term-counter-apr-grid">
            {[7, 30, 90].map((days) => <div key={days}><span>{tr('{days}-DAY APR', { days })}</span><strong>{history.data ? aprLabel(history.data.aprBps?.[`days${days}`], tr, days) : '—'}</strong></div>)}
          </div>
          {history.data && <div className="term-counter-current-price"><span>{tr('Current NAV per pkCTR share')}</span><strong>${money(Number(history.data.currentNavPerShareE18) / 1e15, 4)} USDG</strong></div>}
          {history.isError && <p className="term-negative">{tr('APR history is unavailable until the Counter history database is ready.')}</p>}
          {history.data && !history.data.snapshots.length && <p>{tr('The first on-chain snapshot is being collected. APR appears after a full measurement window.')}</p>}
          <CounterNavChart snapshots={history.data?.snapshots} currentAt={history.data?.currentAt} currentNavPerShareE18={history.data?.currentNavPerShareE18} tr={tr} />
          {history.data?.historyStartsAt && <small className="term-counter-footnote">{tr('History starts {date}; earlier NAV snapshots are not available.', { date: new Date(history.data.historyStartsAt).toLocaleString() })}</small>}
        </section>
        <section className="term-large-panel term-counter-drivers">
          <div className="term-counter-section-heading"><div><span className="term-overline">{tr('LAST 30 DAYS')}</span><h2>{tr('What moved the pool')}</h2></div></div>
          <div className="term-detail"><span>{tr('Trading fees allocated to Counter')}</span><b className="term-positive">{activity ? usd2(activity.counterFeeIncomeUsdg) : '—'}</b></div>
          <div className="term-detail"><span>{tr('Opposite of traders’ realized P&L')}</span><b className={activity && BigInt(activity.counterSideTraderPnlUsdg) < 0n ? 'term-negative' : 'term-positive'}>{activity ? signedUsdg(activity.counterSideTraderPnlUsdg) : '—'}</b></div>
          <div className="term-detail"><span>{tr('Bad debt created')}</span><b className="term-negative">{activity ? usd2(activity.badDebtCreatedUsdg) : '—'}</b></div>
          <div className="term-detail"><span>{tr('Bad debt covered')}</span><b>{activity ? usd2(activity.badDebtCoveredUsdg) : '—'}</b></div>
          <p className="term-counter-footnote">{tr('Event totals are not a full cash-flow reconciliation. Trader P&L is shown as its exact opposite, not cash collected; losses beyond margin may become bad debt. Borrow and unrealized P&L affect NAV per share but are not itemized here.')}</p>
          {history.data && !history.data.activityReady && <p>{tr('Activity totals are catching up with the chain.')}</p>}
          {!activity && history.isError && <p>{tr('Activity totals are unavailable until the indexer database is ready.')}</p>}
        </section>
      </div>
      <section className="term-large-panel term-counter-exposure">
        <div className="term-counter-section-heading"><div><span className="term-overline">{tr('LIVE · REFRESHES EVERY 15 SECONDS')}</span><h2>{tr('Exposure by stock')}</h2></div></div>
        <p>{tr('Open long and short notional by market. Net exposure is long minus short.')}</p>
        {ledger.isError && !ledger.data ? <div className="term-empty">{tr('Live exposure is unavailable right now.')}</div> : exposureRows.length ? <div className="term-counter-exposure-list">{exposureRows.map((row) => {
          const longOi = big(row.longOiUsdg);
          const shortOi = big(row.shortOiUsdg);
          const gross = longOi + shortOi;
          const width = maxGrossOi > 0 ? Math.max(1, usdgNum(gross) / maxGrossOi * 100) : 0;
          return <div className="term-counter-exposure-row" key={row.symbol}>
            <strong>{row.symbol}</strong>
            <div className="term-counter-exposure-bar"><i style={{ width: `${width}%` }} /></div>
            <span>{tr('Long')} {usd0(row.longOiUsdg)} / {tr('Short')} {usd0(row.shortOiUsdg)}</span>
            <b>{tr('Net')} {longOi >= shortOi ? '+' : '−'}{usd0(longOi >= shortOi ? longOi - shortOi : shortOi - longOi)}</b>
          </div>;
        })}</div> : <div className="term-empty">{tr('No market exposure data yet.')}</div>}
      </section>
      <div className="term-counter-grid">
        <div className="term-large-panel">
          <h2>{tr('The loss waterfall')} <span>01 → 05</span></h2>
          <p>{tr('Each layer is used before the next. Counter LPs can lose capital.')}</p>
          <div className="term-waterfall">{['Market bad-debt bucket', 'Backstop Fund', 'First-Loss tranche', 'Counter LPs', 'Affected-market auto-deleveraging'].map((label, i) => <div key={label}><span>0{i + 1}</span><strong>{tr(label)}</strong><i style={{ width: `${84 - i * 11}%` }} /></div>)}</div>
          <div className="term-detail"><span>{tr('Withdrawal queue')}</span><b className={c?.deleveraging ? 'term-negative' : ''}>{!c ? '—' : tr(c.deleveraging ? 'Deleveraging: opens stopped' : oldest > 0 ? `Oldest request waiting ${Math.round(oldest / 3600)}h` : 'No requests waiting')}</b></div>
          <a className="term-text-link" href="/docs?topic=mechanics">{tr('Read the settlement mechanics')} ↗</a>
        </div>
        <form className="term-large-panel term-counter-form" onSubmit={request}>
          <h2>{tr(connected ? 'Provide or withdraw liquidity' : 'Connect to provide liquidity')}</h2>
          <div className="term-switch">{['Deposit', 'Withdraw'].map((item) => <button key={item} type="button" aria-pressed={action === item} className={action === item ? 'active' : ''} onClick={() => { setAction(item); setError(''); }}>{tr(item)}</button>)}</div>
          <label className="term-field">{tr(action === 'Deposit' ? 'USDG amount' : 'Share amount')}
            <div><input type="number" min="0" step="any" aria-label={tr(action === 'Deposit' ? 'Deposit amount in USDG' : 'Withdraw amount in shares')} value={amount} onChange={(e) => setAmount(e.target.value)} required /><span>{tr(action === 'Deposit' ? 'USDG' : 'SHARES')}</span></div>
          </label>
          <div className="term-quick-values"><button type="button" disabled={!connected} onClick={() => setAmount(action === 'Deposit' ? String(Math.floor(account.wallet * 100) / 100) : formatUnits(account.shares, SHARE_DECIMALS, SHARE_DECIMALS))}>{tr('Max')}</button></div>
          <p className="term-fineprint">
            {tr(connected ? `Wallet: ${money(account.wallet)} USDG · Your shares: ${formatUnits(account.shares, SHARE_DECIMALS, 4)} (about ${money(account.sharesValue)} USDG).` : 'Connect a wallet to see your balance.')}{' '}
            {tr(action === 'Deposit'
              ? 'USDG is escrowed when you submit. Shares are minted on settlement, usually after the next mark, at the less favorable of the request and settlement prices. If the Counter has no open positions, it can settle sooner.'
              : 'Shares are queued when you submit. Withdrawals settle after the next mark, or sooner if the Counter has no open positions. Cash shortages are filled pro rata.')}
          </p>
          {error && <p role="alert" className="term-form-error">{tr(error)}</p>}
          <TxProgress step={t.trader.step} hash={t.trader.hash} />
          <button className="term-primary" type="submit" disabled={t.trader.busy}>{tr(connected ? `Request ${action.toLowerCase()}` : 'Connect wallet')} <Arrow /></button>
          <p className="term-fineprint">{tr("After 72 hours, an unfilled withdrawal triggers deleveraging; it is not a guaranteed payout time. Your capital backs every trader's winnings.")}</p>
        </form>
      </div>
      <div className="term-large-panel">
        <h2>{tr('Your requests')} <span>{tr('{n} TRACKED', { n: visibleRequests.length })}</span></h2>
        <p className="term-fineprint">{tr('Pending Counter requests are saved in this browser. Settlement alerts appear here while the terminal is open.')}</p>
        {visibleRequests.filter((r) => r.requestId && r.status !== 'settled').map((request) => (
          <CounterRequestWatcher key={request.key} request={request} vault={contracts?.vault} onSettled={markSettled} onPartial={markPartial} />
        ))}
        {visibleRequests.length ? (
          <div className="term-table-wrap"><table><thead><tr><th>{tr('Request')}</th><th>{tr('Amount')}</th><th>{tr('Status')}</th><th>{tr('When')}</th></tr></thead><tbody>
            {visibleRequests.map((r) => <tr key={r.key}><td>{tr(r.action)}</td><td>{tr(r.text)}</td><td>{r.status === 'settled' ? <>{tr('Settled on-chain')} · {r.hash && <a className="term-text-link" href={explorerTx(r.hash)} target="_blank" rel="noreferrer">{tr('Request transaction')} ↗</a>}</> : r.hash ? <a className="term-table-tag" href={explorerTx(r.hash)} target="_blank" rel="noreferrer">{tr(r.status === 'untracked' ? 'Submitted · settlement tracking unavailable' : r.status === 'partial' ? 'Partially settled · remaining queued' : 'Submitted · pending next mark')} ↗</a> : tr('Submitted')}</td><td>{tr(relativeTime(r.at))}</td></tr>)}
          </tbody></table></div>
        ) : <div className="term-empty">{tr('Requests you make appear here.')}<small>{tr('Two-step settlement keeps the request separate from the mark; your share balance updates when it settles.')}</small></div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the Tape

export function HeatmapView({ markets }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const sorted = [...markets].sort((a, b) => {
    const ac = a.change === null ? -Infinity : Number(a.change);
    const bc = b.change === null ? -Infinity : Number(b.change);
    return bc - ac;
  });
  const maxMove = sorted.reduce((max, market) => market.change === null ? max : Math.max(max, Math.abs(Number(market.change))), 0);

  return (
    <section className="term-secondary-view term-market-heatmap">
      <div className="term-view-title">
        <div><p className="term-overline">{tr('ALL LISTINGS')}</p><h1>{tr('Market heatmap')}</h1><p>{tr('Compare each listing’s mark with its on-chain reference close. Tile size is equal; color shows the direction and size of the move.')}</p></div>
        <span className="term-small-badge">{tr('{n} MARKETS', { n: markets.length })}</span>
      </div>
      <div className="term-heatmap-legend"><span><i className="is-negative" />{tr('Down')}</span><span><i className="is-neutral" />{tr('Flat or no reference')}</span><span><i className="is-positive" />{tr('Up')}</span></div>
      {sorted.length ? <div className="term-heatmap-grid" aria-label={tr('All listed markets heatmap')}>
        {sorted.map((market) => {
          const change = market.change === null ? null : Number(market.change);
          const intensity = change === null || maxMove === 0 ? 0 : Math.min(3, Math.max(1, Math.ceil(Math.abs(change) / maxMove * 3)));
          const color = change === null || Math.abs(change) < 0.01 ? 'flat' : change > 0 ? `up-${intensity}` : `down-${intensity}`;
          const price = Number(market.price);
          const priceText = price > 0 ? price.toLocaleString('en-US', { minimumFractionDigits: price >= 100 ? 2 : price >= 1 ? 3 : 4, maximumFractionDigits: price >= 100 ? 2 : price >= 1 ? 3 : 4 }) : '—';
          const changeText = change === null ? tr(market.statusLabel) : `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change).toFixed(2)}%`;
          return <button type="button" key={market.symbol} className={`term-heatmap-tile is-${color}`} onClick={() => t.chooseMarket(market.symbol)} aria-label={tr('Open {symbol} market, mark {price} USDG, change {change}', { symbol: market.symbol, price: priceText, change: changeText })}>
            <span className="term-heatmap-tile-top"><strong>{market.symbol}</strong><small>{tr(market.classLabel)}</small></span>
            <span className="term-heatmap-tile-change">{changeText}</span>
            <span className="term-heatmap-tile-price">{priceText} <small>USDG</small></span>
            <span className="term-heatmap-tile-status">{tr(market.statusLabel)}</span>
          </button>;
        })}
      </div> : <div className="term-empty">{tr('No listings are available right now.')}</div>}
      <p className="term-counter-footnote">{tr('Moves compare the current on-chain mark with its reference close; they are not rolling 24-hour returns.')}</p>
    </section>
  );
}

export function TapeView({ markets, alerts, removeAlert, favorites, toggleFavorite, active = true }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const [tab, setTab] = useState(() => tapeTabFrom(window.location.search));
  const [filter, setFilter] = useState('All');
  const filings = useFilings(active && tab === 'Conditions');
  const catalysts = useCatalysts(active && tab === 'Conditions');
  const changeTab = (next) => {
    setTab(next);
    const q = new URLSearchParams(window.location.search);
    if (next === 'Conditions') q.delete('tape');
    else q.set('tape', next.toLowerCase());
    window.history.replaceState({}, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`);
  };
  const names = new Map(markets.map((m) => [m.symbol, m.name]));
  const events = markets.flatMap((m) => {
    const list = [];
    const base = { symbol: m.symbol, name: m.name };
    if (!m.feedUp) list.push({ ...base, type: 'Feed', title: 'Price service unreachable', body: 'The live price feed is not answering, so this market may not accept new positions. Exits stay available at the on-chain mark.' });
    if (m.warming) list.push({ ...base, type: 'Session', title: 'Price warming up', body: 'A market priced from one source needs a run of confirming checks before new positions can open. This takes about a minute.' });
    if (m.status === 'halted') list.push({ ...base, type: 'Halt', title: 'Trading halted', body: 'The exchange halted this stock. New positions and liquidations are stopped; you can still close.' });
    if (m.status === 'frozen') list.push({ ...base, type: 'Halt', title: 'Market frozen', body: m.freezeReasons.length ? `Reason: ${m.freezeReasons.join(', ')}. New positions are stopped.` : 'Price sources are stale or a corporate action is pending. New positions are stopped.' });
    if (m.status === 'weekend' || m.status === 'extended') list.push({ ...base, type: 'Session', title: m.status === 'weekend' ? 'Weekend session' : 'Extended hours', body: 'The price is held near the last regular close; leverage, size and spreads follow the session limits.' });
    if (m.openGuard) list.push({ ...base, type: 'Session', title: 'Open guard running', body: 'The first minutes after the open use a wider spread and smaller tickets.' });
    if (m.blockers.length && m.status === 'open') list.push({ ...base, type: 'Limit', title: 'New positions unavailable', body: m.blockers[0] });
    if (m.warnings.length) list.push({ ...base, type: 'Limit', title: 'Listing check', body: `${m.warnings.join('; ')}. Whether this stops new positions is decided by the price service.` });
    if (!list.length) list.push({ ...base, type: 'Session', title: 'Open and quoting', body: `Mark ${money(m.price, 2)} USDG${m.confidenceBps !== null ? ` · confidence ±${m.confidenceBps} bps` : ''}${m.dispersionBps !== null ? ` · sources ${m.dispersionBps} bps apart` : ''}.` });
    return list;
  });
  // Recent flagged filings and earnings this week sit beside the market-state cards, newest context first.
  const context = contextEvents({ filings: filings.data?.filings, earnings: catalysts.data?.earnings }).map((e) => ({ ...e, name: names.get(e.symbol) ?? e.symbol }));
  const shown = [...context, ...events].filter((e) => filter === 'All' || e.type === filter);
  return (
    <section className="term-secondary-view">
      <div className="term-view-title">
        <div><p className="term-overline">{tr('MARKET CONDITIONS')}</p><h1>{tr('Keep an eye on the Tape.')}</h1><p>{tr('Market state, a runner scanner, trading halts, SEC filings and the earnings calendar for every market, with price alerts that run in this browser.')}</p></div>
        <button className="term-primary term-auto" onClick={() => t.setDialog({ type: 'alert' })}>{tr('Create price alert')} <Arrow /></button>
      </div>
      <nav className="term-tape-tabs" aria-label={tr('Tape sections')}>
        {TAPE_TABS.map((item) => <button key={item} type="button" className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => changeTab(item)}>{tr(item, null, 'tape')}</button>)}
      </nav>
      {tab === 'Scanner' && <ScannerPanel active={active} markets={markets} />}
      {tab === 'Halts' && <HaltsPanel active={active} />}
      {tab === 'Filings' && <FilingsPanel active={active} markets={markets} />}
      {tab === 'Catalysts' && <CatalystsPanel active={active} markets={markets} />}
      {tab === 'Conditions' && <div className="term-tape-grid">
        <div className="term-large-panel">
          <div className="term-inline-tabs">{['All', 'Halt', 'Session', 'Limit', 'Feed', 'Filing', 'Earnings'].map((item) => <button key={item} className={filter === item ? 'active' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>{tr(item, null, 'tape')}</button>)}</div>
          {shown.map((event, i) => (
            <article className="term-tape-event" key={`${event.symbol}-${event.type}-${i}`}>
              <div>
                <span className="term-symbol-square">{event.symbol.slice(0, 1)}</span>
                <div><strong>{event.symbol}</strong><small>{tr(event.type, null, 'tape')}{event.form ? ` · ${event.form}` : ''} · {tr(event.at ? relativeTime(event.at) : 'LIVE')}</small></div>
                <button className="term-icon-btn" aria-label={tr(`${favorites.includes(event.symbol) ? 'Remove' : 'Add'} ${event.symbol} ${favorites.includes(event.symbol) ? 'from' : 'to'} watchlist`)} aria-pressed={favorites.includes(event.symbol)} onClick={() => toggleFavorite(event.symbol)}>{favorites.includes(event.symbol) ? '★' : '☆'}</button>
              </div>
              <h3>{tr(event.title, event.vars)}</h3>
              <p>{tr(event.body)}{event.note ? <> {tr(event.note)}</> : null}</p>
              {event.link
                ? <a href={event.link} target="_blank" rel="noreferrer">{tr('Read the filing on SEC.gov')} <Arrow /></a>
                : event.type === 'Earnings'
                  ? <button type="button" className="term-tape-link" onClick={() => changeTab('Catalysts')}>{tr('Open the catalyst calendar')} <Arrow /></button>
                  : <a href={`https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(event.symbol)}`} target="_blank" rel="noreferrer">{tr('Search SEC EDGAR for {name}', { name: event.name })} <Arrow /></a>}
            </article>
          ))}
          {!shown.length && <div className="term-empty">{tr('Nothing in this category right now.')}</div>}
        </div>
        <aside className="term-large-panel">
          <h2>{tr('Your price alerts')} <span>{alerts.length}</span></h2>
          <p>{tr('Stored in this browser. They fire while this page is open; they do not send email, Telegram or webhook messages.')}</p>
          {alerts.length ? alerts.map((a) => (
            <div className="term-saved-alert" key={a.id}><strong>{a.symbol}</strong><span>{tr('Price {dir} ${price}', { dir: tr(a.direction.toLowerCase()), price: money(a.price) })}</span><button className="term-mini-btn" onClick={() => removeAlert(a.id)}>{tr('Remove')}</button></div>
          )) : <div className="term-empty">{tr('No alert rules yet.')}<small>{tr('Create a price rule to be told when a market crosses it.')}</small></div>}
          <button className="term-secondary" onClick={() => t.setDialog({ type: 'alert' })}>{tr('Add a rule')} +</button>
          <div className="term-watchlist"><h3>{tr('Watchlist')}</h3>{favorites.map((symbol) => <span key={symbol}>{symbol}</span>)}{!favorites.length && <small>{tr('Star a market to keep it here.')}</small>}</div>
        </aside>
      </div>}
    </section>
  );
}

// ---------------------------------------------------------------- the Ledger

export function LedgerView({ health }) {
  const { t: tr } = useI18n();
  const ledger = useLedger();
  const l = ledger.data;
  const rows = l?.markets ?? [];
  const gross = rows.reduce((s, r) => s + big(r.longOiUsdg) + big(r.shortOiUsdg), 0n);
  const net = rows.reduce((s, r) => s + (big(r.longOiUsdg) - big(r.shortOiUsdg)), 0n);
  const backstopTarget = l ? big(l.counter.backstopTargetUsdg) : 0n;
  const backstopCoverage = backstopTarget > 0n ? Number((big(l.counter.backstopUsdg) * 10_000n) / backstopTarget) / 100 : null;
  const stats = l
    ? [['Pool value · NAV', usd0(l.counter.navUsdg), 'Counter vault'], ['Cash / free cash', `${usd0(l.counter.cashUsdg)} / ${usd0(l.counter.freeCashUsdg)}`, 'Total cash / available cash'], ['Gross open interest', usd0(gross), `${rows.length} active markets`], ['Net exposure', `${net < 0n ? '−' : ''}${usd0(net < 0n ? -net : net)}`, net >= 0n ? 'Traders net long' : 'Traders net short']]
    : [['Pool value · NAV', '—', ''], ['Cash / free cash', '—', ''], ['Gross open interest', '—', ''], ['Net exposure', '—', '']];
  const stress = l ? big(l.stress25.stressNavUsdg) : 0n;
  const stressLoss = l ? big(l.stress25.lossUsdg) : 0n;
  return (
    <section className="term-secondary-view">
      <div className="term-view-title">
        <div><p className="term-overline">{tr('COUNTER HEALTH')}</p><h1>{tr('Live solvency.')}</h1><p>{tr('Pool value, open interest, backstop, and reserves from Robinhood Chain contract reads. Refreshes every 15 seconds.')}</p></div>
        <span className={`term-small-badge ${l ? '' : 'is-off'}`}>{tr(l ? 'LIVE · 15S' : ledger.isError ? 'UNAVAILABLE' : 'LOADING')}</span>
      </div>
      {ledger.isError && !l && <Unavailable what="The ledger" error={ledger.error} />}
      <div className="term-stat-grid">{stats.map(([label, value, note]) => <div key={label}><span>{tr(label)}</span><strong>{value}</strong><small>{tr(note)}</small></div>)}</div>
      <div className="term-counter-grid">
        <div className="term-large-panel">
          <h2>{tr('Backstop and reserves')}</h2>
          {l ? <>
            <div className="term-detail"><span>{tr('Backstop balance / target')}</span><b>{usd0(l.counter.backstopUsdg)} / {usd0(l.counter.backstopTargetUsdg)}</b></div>
            {backstopCoverage !== null && <div className="term-detail"><span>{tr('Backstop target filled')}</span><b>{Math.min(backstopCoverage, 100).toFixed(1)}%</b></div>}
            <div className="term-detail"><span>{tr('Counter reserve')}</span><b>{usd0(l.counter.reserveUsdg)}</b></div>
            <div className="term-detail"><span>{tr('First-loss balance')}</span><b>{usd0(l.counter.firstLossUsdg)}</b></div>
            <div className="term-detail"><span>{tr('Deferred withdrawal claims')}</span><b>{usd0(l.counter.deferredOutstandingUsdg)}</b></div>
            <div className="term-detail"><span>{tr('Bad debt outstanding')}</span><b className={big(l.counter.totalBadDebtUsdg) > 0n ? 'term-negative' : ''}>{usd0(l.counter.totalBadDebtUsdg)}</b></div>
          </> : <div className="term-empty">{tr('Waiting for the contracts.')}</div>}
          <h2 style={{ marginTop: 22 }}>{tr('25% gap scenario')}</h2>
          <p>{tr('Illustrative loss if markets move 25% against net exposure at once. This is a scenario estimate, not a guarantee.')}</p>
          {l && <>
            <div className="term-detail"><span>{tr('Estimated loss')}</span><b className={stressLoss > 0n ? 'term-negative' : ''}>{usd0(stressLoss)}</b></div>
            <div className="term-detail"><span>{tr('Estimated NAV after loss')}</span><b>{usd0(stress)}</b></div>
          </>}
        </div>
        <div className="term-large-panel">
          <h2>{tr('Open positions by market')}</h2>
          {rows.length ? <div className="term-table-wrap"><table><thead><tr><th>{tr('Market')}</th><th>{tr('Long / short OI')}</th><th>{tr('Room long / short')}</th><th>{tr('Bad debt')}</th></tr></thead><tbody>
            {rows.map((r) => <tr key={r.symbol}><td><strong>{r.symbol}</strong></td><td>{usd0(r.longOiUsdg)}<small>{usd0(r.shortOiUsdg)}</small></td><td>{usd0(r.longRoomUsdg)}<small>{usd0(r.shortRoomUsdg)}</small></td><td>{usd0(r.badDebtUsdg)}</td></tr>)}
          </tbody></table></div> : <div className="term-empty">{tr('No market data yet.')}</div>}
          <h2 style={{ marginTop: 22 }}>{tr('Service health')}</h2>
          {health.map(([label, ok, note]) => <div className="term-detail" key={label}><span>{tr(label)}</span><b className={ok ? 'term-positive' : 'term-negative'}>{tr(ok ? 'Connected' : note ?? 'Not connected')}</b></div>)}
          <a href="/docs?topic=security" className="term-text-link">{tr('Read the security model')} ↗</a>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the public weekly leaderboard

export function LeaderboardView({ active = true }) {
  const { t: tr, lang } = useI18n();
  const locale = lang === 'zh-CN' ? 'zh-CN' : 'en';
  const query = useLeaderboard(active);
  const data = query.data;
  const rows = data?.rows ?? [];
  const formatPnl = (value) => {
    const amount = big(value);
    return `${amount < 0n ? '−' : '+'}$${formatUnits(amount < 0n ? -amount : amount, 6, 2)}`;
  };
  const date = (value) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value));
  return (
    <section className="term-secondary-view">
      <div className="term-view-title">
        <div><p className="term-overline">{tr('PUBLIC ACTIVITY')}</p><h1>{tr('Weekly leaderboard.')}</h1><p>{tr('Wallets ranked by realized P&L after recorded trade fees during the current UTC week.')}</p></div>
        <span className={`term-small-badge ${data ? '' : 'is-off'}`}>{tr(data ? 'LIVE · 30S' : query.isError ? 'UNAVAILABLE' : 'LOADING')}</span>
      </div>
      {query.isError && !data && <Unavailable what="The leaderboard" error={query.error} />}
      {data && <div className="term-leaderboard-period"><strong>{tr('UTC WEEK')}</strong><span>{date(data.startsAt)} – {date(new Date(new Date(data.endsAt).getTime() - 1))}</span><small>{tr('Updated {time}', { time: new Date(data.generatedAt).toLocaleTimeString(locale, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) })}</small></div>}
      <div className="term-large-panel term-leaderboard-panel">
        <h2>{tr('Top traders')} <span>{rows.length}</span></h2>
        <p>{tr('Net realized P&L is realized P&L minus recorded trade fees. Open-position P&L and borrow are excluded. This board has no prizes.')}</p>
        {rows.length ? <div className="term-table-wrap"><table><thead><tr><th>{tr('Rank')}</th><th>{tr('Wallet')}</th><th>{tr('Net realized')}</th><th>{tr('Realized P&L')}</th><th>{tr('Fees')}</th><th>{tr('Fills')}</th></tr></thead><tbody>
          {rows.map((row) => <tr key={row.trader}><td><strong>#{row.rank}</strong></td><td><a className="term-leaderboard-wallet" href={explorerAddress(row.trader)} target="_blank" rel="noreferrer">{shortAddress(row.trader)} ↗</a></td><td className={big(row.netPnlUsdg) > 0n ? 'term-positive' : big(row.netPnlUsdg) < 0n ? 'term-negative' : ''}><strong>{formatPnl(row.netPnlUsdg)}</strong></td><td>{formatPnl(row.realizedPnlUsdg)}</td><td>${formatUnits(big(row.feesUsdg), 6, 2)}</td><td>{row.fills}</td></tr>)}
        </tbody></table></div> : <div className="term-empty">{tr('No indexed fills this UTC week yet.')}<small>{tr('Rankings refresh automatically as the indexer records trades.')}</small></div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Rewards (planned, not live)

export function RewardsView() {
  const { t: tr } = useI18n();
  const [tab, setTab] = useState('Pennies');
  return (
    <section className="term-secondary-view">
      <div className="term-view-title"><div><p className="term-overline">{tr('PLKT IS LIVE. PENNIES ARE NOT.')}</p><h1>{tr('Participation with published rules.')}</h1><p>{tr('Pennies and the Penny Cup are planned features. They are not live: no points are issued and no competition is open.')}</p></div><span className="term-small-badge">{tr('PLANNED')}</span></div>
      <div className="term-inline-tabs">{['Pennies', 'Penny Cup'].map((item) => <button key={item} aria-pressed={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{tr(item)}</button>)}</div>
      <div className="term-counter-grid term-rewards-grid">
        <div className="term-large-panel">
          <h2>{tr(tab === 'Pennies' ? 'Points follow participation.' : 'A weekly trading competition.')}</h2>
          <p>{tr(tab === 'Pennies' ? 'The plan weights fees paid, Cup results and referrals that actually trade. Raw volume alone counts for zero.' : 'The planned leaderboard ranks PnL as a percentage of the maximum margin used. At least $25 in fees during the week is required to qualify.')}</p>
          {(tab === 'Pennies' ? [['Transferability', 'Non-transferable'], ['Round trips under 60 seconds', 'Excluded'], ['Linked funding sources', 'Clustered'], ['Weekly totals', 'Merkle root with challenge window'], ['Token entitlement', 'None']] : [['Rank basis', 'PnL% / maximum margin used'], ['Minimum weekly fees', '$25'], ['Average holding time', 'At least 1 hour'], ['Linked opposite-side trades', 'Excluded'], ['Prizes', 'USDG; amount published before a round']]).map(([label, value]) => <div className="term-detail" key={label}><span>{tr(label)}</span><b>{tr(value)}</b></div>)}
        </div>
        <div className="term-large-panel">
          <h2>{tr(tab === 'Pennies' ? 'No points balance.' : 'No live round is open.')}</h2>
          <div className="term-empty"><strong className="term-reward-number">—</strong><small>{tr(tab === 'Pennies' ? 'A verified account and points indexer are required.' : 'The leaderboard requires indexed, verified trades.')}</small></div>
          <p>{tr('$PLKT is live. Pennies are a separate planned points feature and are not currently active.')}</p>
          <a className="term-text-link" href="/#roadmap">{tr('Read the dated roadmap')} ↗</a>
        </div>
      </div>
    </section>
  );
}
