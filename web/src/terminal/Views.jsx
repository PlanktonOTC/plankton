import React, { useState } from 'react';
import { Arrow, TxProgress, useTerminal } from './shared.jsx';
import { useCounter, useLedger } from '../live/queries.js';
import { relativeTime } from '../live/model.js';
import { counterDeposit, counterWithdraw } from '../live/trade.js';
import { explorerTx } from '../live/wagmi.js';
import { big, formatUnits, money, parseUnits, parseUsdg, usdgNum } from '../live/units.js';

const SHARE_DECIMALS = 9;
const usd0 = (v) => `$${money(usdgNum(v), 0)}`;
const usd2 = (v) => `$${money(usdgNum(v))}`;

function Unavailable({ what, error }) {
  return <div className="term-info-banner" role="status">{what} is unavailable right now{error?.status === 503 ? ': the exchange contracts are not reachable.' : '.'} It reloads on its own.</div>;
}

// ---------------------------------------------------------------- the Counter

export function CounterView({ account }) {
  const t = useTerminal();
  const counter = useCounter();
  const c = counter.data;
  const [action, setAction] = useState('Deposit');
  const [amount, setAmount] = useState('100');
  const [error, setError] = useState('');
  const [requests, setRequests] = useState([]);
  const connected = t.wallet.isConnected;

  async function request(event) {
    event.preventDefault();
    setError('');
    if (!connected) return t.openWallet();
    const isDeposit = action === 'Deposit';
    const value = isDeposit ? parseUsdg(amount) : parseUnits(amount, SHARE_DECIMALS);
    if (value === null || value <= 0n) return setError('Enter an amount above 0.');
    if (isDeposit && usdgNum(value) > account.wallet + 1e-9) return setError(`Your wallet holds ${money(account.wallet)} USDG.`);
    if (!isDeposit && value > account.shares) return setError(`You hold ${formatUnits(account.shares, SHARE_DECIMALS, 4)} Counter shares.`);
    const result = await t.trader.run((ctx) => (isDeposit ? counterDeposit(ctx, value) : counterWithdraw(ctx, value)));
    if (result.ok) {
      setRequests((prev) => [{ id: Date.now(), action, text: isDeposit ? `${money(usdgNum(value))} USDG` : `${formatUnits(value, SHARE_DECIMALS, 4)} shares`, hash: result.hash, at: Date.now() }, ...prev]);
      t.notify(`${action} requested. It settles after the next mark, at the worse of two prices.`);
    } else setError(result.message);
  }

  const stats = c
    ? [['Counter NAV', usd2(c.navUsdg), 'Pool value after trader PnL'], ['Free cash', usd2(c.freeCashUsdg), 'Not backing positions or payouts'], ['Backstop Fund', usd2(c.backstopUsdg), `Target ${usd0(c.backstopTargetUsdg)}`], ['First-Loss tranche', usd2(c.firstLossUsdg), 'Junior capital ahead of LPs']]
    : [['Counter NAV', '—', ''], ['Free cash', '—', ''], ['Backstop Fund', '—', ''], ['First-Loss tranche', '—', '']];
  const oldest = c ? Number(big(c.oldestPendingWithdrawAgeSec)) : 0;

  return (
    <section className="term-secondary-view">
      <div className="term-view-title">
        <div><p className="term-overline">THE COUNTER · LIQUIDITY POOL</p><h1>One pool. A visible risk budget.</h1><p>The Counter is the other side of every trade. Liquidity providers can lose capital. All figures below are read from the contracts.</p></div>
        <span className={`term-small-badge ${c ? '' : 'is-off'}`}>{c ? 'LIVE' : counter.isError ? 'UNAVAILABLE' : 'LOADING'}</span>
      </div>
      {counter.isError && !c && <Unavailable what="The Counter" error={counter.error} />}
      <div className="term-stat-grid">{stats.map(([label, value, note]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div>
      <div className="term-counter-grid">
        <div className="term-large-panel">
          <h2>The loss waterfall <span>01 → 05</span></h2>
          <p>Each layer is used before the next. Counter LPs can lose capital.</p>
          <div className="term-waterfall">{['Market bad-debt bucket', 'Backstop Fund', 'First-Loss tranche', 'Counter LPs', 'Affected-market auto-deleveraging'].map((label, i) => <div key={label}><span>0{i + 1}</span><strong>{label}</strong><i style={{ width: `${84 - i * 11}%` }} /></div>)}</div>
          <div className="term-detail"><span>Withdrawal queue</span><b className={c?.deleveraging ? 'term-negative' : ''}>{!c ? '—' : c.deleveraging ? 'Deleveraging: opens stopped' : oldest > 0 ? `Oldest request waiting ${Math.round(oldest / 3600)}h` : 'No requests waiting'}</b></div>
          <a className="term-text-link" href="/docs?topic=mechanics">Read the settlement mechanics ↗</a>
        </div>
        <form className="term-large-panel term-counter-form" onSubmit={request}>
          <h2>{connected ? 'Provide or withdraw liquidity' : 'Connect to provide liquidity'}</h2>
          <div className="term-switch">{['Deposit', 'Withdraw'].map((item) => <button key={item} type="button" aria-pressed={action === item} className={action === item ? 'active' : ''} onClick={() => { setAction(item); setError(''); }}>{item}</button>)}</div>
          <label className="term-field">{action === 'Deposit' ? 'USDG amount' : 'Share amount'}
            <div><input type="number" min="0" step="any" aria-label={action === 'Deposit' ? 'Deposit amount in USDG' : 'Withdraw amount in shares'} value={amount} onChange={(e) => setAmount(e.target.value)} required /><span>{action === 'Deposit' ? 'USDG' : 'SHARES'}</span></div>
          </label>
          <div className="term-quick-values"><button type="button" disabled={!connected} onClick={() => setAmount(action === 'Deposit' ? String(Math.floor(account.wallet * 100) / 100) : formatUnits(account.shares, SHARE_DECIMALS, SHARE_DECIMALS))}>Max</button></div>
          <p className="term-fineprint">
            {connected ? `Wallet: ${money(account.wallet)} USDG · Your shares: ${formatUnits(account.shares, SHARE_DECIMALS, 4)} (about ${money(account.sharesValue)} USDG).` : 'Connect a wallet to see your balance.'}{' '}
            {action === 'Deposit'
              ? 'USDG is escrowed when you submit. Shares are minted on settlement, usually after the next mark, at the less favorable of the request and settlement prices. If the Counter has no open positions, it can settle sooner.'
              : 'Shares are queued when you submit. Withdrawals settle after the next mark, or sooner if the Counter has no open positions. Cash shortages are filled pro rata.'}
          </p>
          {error && <p role="alert" className="term-form-error">{error}</p>}
          <TxProgress step={t.trader.step} hash={t.trader.hash} />
          <button className="term-primary" type="submit" disabled={t.trader.busy}>{connected ? `Request ${action.toLowerCase()}` : 'Connect wallet'} <Arrow /></button>
          <p className="term-fineprint">After 72 hours, an unfilled withdrawal triggers deleveraging; it is not a guaranteed payout time. Your capital backs every trader's winnings.</p>
        </form>
      </div>
      <div className="term-large-panel">
        <h2>Your requests <span>{requests.length} THIS SESSION</span></h2>
        {requests.length ? (
          <div className="term-table-wrap"><table><thead><tr><th>Request</th><th>Amount</th><th>Status</th><th>When</th></tr></thead><tbody>
            {requests.map((r) => <tr key={r.id}><td>{r.action}</td><td>{r.text}</td><td>{r.hash ? <a className="term-table-tag" href={explorerTx(r.hash)} target="_blank" rel="noreferrer">Submitted · pending next mark ↗</a> : 'Submitted'}</td><td>{relativeTime(r.at)}</td></tr>)}
          </tbody></table></div>
        ) : <div className="term-empty">Requests you make appear here.<small>Two-step settlement keeps the request separate from the mark; your share balance updates when it settles.</small></div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the Tape

export function TapeView({ markets, alerts, removeAlert, favorites, toggleFavorite }) {
  const t = useTerminal();
  const [filter, setFilter] = useState('All');
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
  const shown = events.filter((e) => filter === 'All' || e.type === filter);
  return (
    <section className="term-secondary-view">
      <div className="term-view-title">
        <div><p className="term-overline">MARKET CONDITIONS</p><h1>Keep an eye on the Tape.</h1><p>The state of every market right now, and price alerts that run in this browser.</p></div>
        <button className="term-primary term-auto" onClick={() => t.setDialog({ type: 'alert' })}>Create price alert <Arrow /></button>
      </div>
      <div className="term-tape-grid">
        <div className="term-large-panel">
          <div className="term-inline-tabs">{['All', 'Halt', 'Session', 'Limit', 'Feed'].map((item) => <button key={item} className={filter === item ? 'active' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}</button>)}</div>
          {shown.map((event, i) => (
            <article className="term-tape-event" key={`${event.symbol}-${i}`}>
              <div>
                <span className="term-symbol-square">{event.symbol.slice(0, 1)}</span>
                <div><strong>{event.symbol}</strong><small>{event.type} · LIVE</small></div>
                <button className="term-icon-btn" aria-label={`${favorites.includes(event.symbol) ? 'Remove' : 'Add'} ${event.symbol} ${favorites.includes(event.symbol) ? 'from' : 'to'} watchlist`} aria-pressed={favorites.includes(event.symbol)} onClick={() => toggleFavorite(event.symbol)}>{favorites.includes(event.symbol) ? '★' : '☆'}</button>
              </div>
              <h3>{event.title}</h3>
              <p>{event.body}</p>
              <a href={`https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(event.symbol)}`} target="_blank" rel="noreferrer">Search SEC EDGAR for {event.name} <Arrow /></a>
            </article>
          ))}
          {!shown.length && <div className="term-empty">Nothing in this category right now.</div>}
        </div>
        <aside className="term-large-panel">
          <h2>Your price alerts <span>{alerts.length}</span></h2>
          <p>Stored in this browser. They fire while this page is open; they do not send email, Telegram or webhook messages.</p>
          {alerts.length ? alerts.map((a) => (
            <div className="term-saved-alert" key={a.id}><strong>{a.symbol}</strong><span>Price {a.direction.toLowerCase()} ${money(a.price)}</span><button className="term-mini-btn" onClick={() => removeAlert(a.id)}>Remove</button></div>
          )) : <div className="term-empty">No alert rules yet.<small>Create a price rule to be told when a market crosses it.</small></div>}
          <button className="term-secondary" onClick={() => t.setDialog({ type: 'alert' })}>Add a rule +</button>
          <div className="term-watchlist"><h3>Watchlist</h3>{favorites.map((symbol) => <span key={symbol}>{symbol}</span>)}{!favorites.length && <small>Star a market to keep it here.</small>}</div>
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the Ledger

export function LedgerView({ health }) {
  const ledger = useLedger();
  const l = ledger.data;
  const rows = l?.markets ?? [];
  const gross = rows.reduce((s, r) => s + big(r.longOiUsdg) + big(r.shortOiUsdg), 0n);
  const net = rows.reduce((s, r) => s + (big(r.longOiUsdg) - big(r.shortOiUsdg)), 0n);
  const stats = l
    ? [['Counter NAV', usd0(l.counter.navUsdg), 'From the vault contract'], ['Gross open interest', usd0(gross), `${rows.length} market${rows.length === 1 ? '' : 's'}`], ['Net exposure', `${net < 0n ? '−' : ''}${usd0(net < 0n ? -net : net)}`, net >= 0n ? 'Traders net long' : 'Traders net short'], ['Deferred payouts', usd0(l.counter.deferredOutstandingUsdg), 'Owed, not yet claimable']]
    : [['Counter NAV', '—', ''], ['Gross open interest', '—', ''], ['Net exposure', '—', ''], ['Deferred payouts', '—', '']];
  const stress = l ? big(l.stress25.stressNavUsdg) : 0n;
  const stressLoss = l ? big(l.stress25.lossUsdg) : 0n;
  return (
    <section className="term-secondary-view">
      <div className="term-view-title">
        <div><p className="term-overline">TRANSPARENCY</p><h1>Read the numbers behind the desk.</h1><p>Every figure here is read from the contracts when you open the page. Nothing is stored or estimated by PlanktonOTC.</p></div>
        <span className={`term-small-badge ${l ? '' : 'is-off'}`}>{l ? 'LIVE' : ledger.isError ? 'UNAVAILABLE' : 'LOADING'}</span>
      </div>
      {ledger.isError && !l && <Unavailable what="The ledger" error={ledger.error} />}
      <div className="term-stat-grid">{stats.map(([label, value, note]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div>
      <div className="term-counter-grid">
        <div className="term-large-panel">
          <h2>25% gap stress test</h2>
          <p>If every market gapped 25% against the Counter at once, in the worst direction for its net exposure.</p>
          {l ? <>
            <div className="term-detail"><span>NAV today</span><b>{usd0(l.counter.navUsdg)}</b></div>
            <div className="term-detail"><span>Loss in the scenario</span><b className={stressLoss > 0n ? 'term-negative' : ''}>{usd0(stressLoss)}</b></div>
            <div className="term-detail"><span>NAV after the stress</span><b>{usd0(stress)}</b></div>
            <div className="term-detail"><span>Backstop Fund / target</span><b>{usd0(l.counter.backstopUsdg)} / {usd0(l.counter.backstopTargetUsdg)}</b></div>
            <div className="term-detail"><span>Bad debt outstanding</span><b className={big(l.counter.totalBadDebtUsdg) > 0n ? 'term-negative' : ''}>{usd0(l.counter.totalBadDebtUsdg)}</b></div>
          </> : <div className="term-empty">Waiting for the contracts.</div>}
          <h2 style={{ marginTop: 22 }}>v1 fee routing</h2>
          <div className="term-fee-bar"><i /><i /><i /></div>
          {[['Counter', '75%'], ['Backstop Fund', '20%'], ['Treasury', '5%']].map(([label, value]) => <div className="term-detail" key={label}><span>{label}</span><b>{value}</b></div>)}
          <p className="term-fineprint">After any referral rebate. When the Backstop reaches 10% of Counter NAV, its share redirects to the Counter.</p>
        </div>
        <div className="term-large-panel">
          <h2>Markets</h2>
          {rows.length ? <div className="term-table-wrap"><table><thead><tr><th>Market</th><th>Long / short OI</th><th>Room long / short</th><th>Bad debt</th></tr></thead><tbody>
            {rows.map((r) => <tr key={r.symbol}><td><strong>{r.symbol}</strong></td><td>{usd0(r.longOiUsdg)}<small>{usd0(r.shortOiUsdg)}</small></td><td>{usd0(r.longRoomUsdg)}<small>{usd0(r.shortRoomUsdg)}</small></td><td>{usd0(r.badDebtUsdg)}</td></tr>)}
          </tbody></table></div> : <div className="term-empty">No market data yet.</div>}
          <h2 style={{ marginTop: 22 }}>Service health</h2>
          {health.map(([label, ok, note]) => <div className="term-detail" key={label}><span>{label}</span><b className={ok ? 'term-positive' : 'term-negative'}>{ok ? 'Connected' : note ?? 'Not connected'}</b></div>)}
          <a href="/docs?topic=security" className="term-text-link">Read the security model ↗</a>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Rewards (planned, not live)

export function RewardsView() {
  const [tab, setTab] = useState('Pennies');
  return (
    <section className="term-secondary-view">
      <div className="term-view-title"><div><p className="term-overline">POINTS FIRST. NO TOKEN YET.</p><h1>Participation with published rules.</h1><p>Pennies and the Penny Cup are planned features. They are not live: no points are issued and no competition is open.</p></div><span className="term-small-badge">PLANNED</span></div>
      <div className="term-inline-tabs">{['Pennies', 'Penny Cup'].map((item) => <button key={item} aria-pressed={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
      <div className="term-counter-grid term-rewards-grid">
        <div className="term-large-panel">
          <h2>{tab === 'Pennies' ? 'Points follow participation.' : 'A weekly trading competition.'}</h2>
          <p>{tab === 'Pennies' ? 'The plan weights fees paid, Cup results and referrals that actually trade. Raw volume alone counts for zero.' : 'The planned leaderboard ranks PnL as a percentage of the maximum margin used. At least $25 in fees during the week is required to qualify.'}</p>
          {(tab === 'Pennies' ? [['Transferability', 'Non-transferable'], ['Round trips under 60 seconds', 'Excluded'], ['Linked funding sources', 'Clustered'], ['Weekly totals', 'Merkle root with challenge window'], ['Token entitlement', 'None']] : [['Rank basis', 'PnL% / maximum margin used'], ['Minimum weekly fees', '$25'], ['Average holding time', 'At least 1 hour'], ['Linked opposite-side trades', 'Excluded'], ['Prizes', 'USDG; amount published before a round']]).map(([label, value]) => <div className="term-detail" key={label}><span>{label}</span><b>{value}</b></div>)}
        </div>
        <div className="term-large-panel">
          <h2>{tab === 'Pennies' ? 'No points balance.' : 'No live round is open.'}</h2>
          <div className="term-empty"><strong className="term-reward-number">—</strong><small>{tab === 'Pennies' ? 'A verified account and points indexer are required.' : 'The leaderboard requires indexed, verified trades.'}</small></div>
          <p>There is no PLANKTON token. Points do not guarantee a token or an airdrop.</p>
          <a className="term-text-link" href="/#roadmap">Read the dated roadmap ↗</a>
        </div>
      </div>
    </section>
  );
}
