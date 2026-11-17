import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Providers from './live/Providers.jsx';
import { useAccountHistory, useAccountState, useConfig, useMarkets } from './live/queries.js';
import { useTrader, useWallet } from './live/useTrader.js';
import { accountView, marketView, orderView, tradeView } from './live/model.js';
import { friendlyError } from './live/errors.js';
import { compact, money, priceDigits, shortAddress, signed } from './live/units.js';
import { PRIVY_APP_ID } from './live/env.js';
import { Arrow, Terminal, useStored } from './terminal/shared.jsx';
import Chart from './terminal/Chart.jsx';
import Positions from './terminal/Positions.jsx';
import Ticket from './terminal/Ticket.jsx';
import { CounterView, LeaderboardView, LedgerView, RewardsView, TapeView } from './terminal/Views.jsx';
import ReferralsView from './terminal/Referrals.jsx';
import { AccountDialog, AlertDialog, CancelOrderDialog, CapacityDialog, CloseAtMarkDialog, CloseDialog, CommandMenu, MarginDialog, ProtectionDialog, RiskDialog, ShortcutsDialog, SourcesDialog, WalletDialog } from './terminal/Dialogs.jsx';
import MarketTile, { CompanyMark } from './MarketRail';
import { LangSwitch, useI18n } from './i18n';
import './dashboard.css';
import './supporting-metal.css';
import './terminal/live.css';

const VIEWS = { counter: 'Counter', tape: 'Tape', ledger: 'Solvency', solvency: 'Solvency', leaderboard: 'Leaderboard', rewards: 'Rewards', referrals: 'Referrals' };
const params = () => new URLSearchParams(window.location.search);

function TerminalApp() {
  const { t: tr } = useI18n();
  const workspace = useRef(null);
  const wallet = useWallet();
  const configQuery = useConfig();
  const marketsQuery = useMarkets();
  const stateQuery = useAccountState(wallet.isConnected ? wallet.address : undefined);
  const historyQuery = useAccountHistory(wallet.isConnected ? wallet.address : undefined);
  const trader = useTrader(configQuery.data);

  const [view, setView] = useState(() => VIEWS[params().get('view')] || (params().has('ref') ? 'Referrals' : 'Trade'));
  const [inviteAddress] = useState(() => params().get('ref') || '');
  const [selected, setSelected] = useState(() => params().get('market')?.toUpperCase() ?? '');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState('');
  const [bottomTab, setBottomTab] = useState('Positions');
  const [favorites, setFavorites] = useStored('plankton.favorites', []);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [alerts, setAlerts] = useStored('plankton.alerts', []);
  const [focusMode, setFocusMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [sideRequest, setSideRequest] = useState(null);

  // ---- derived data -------------------------------------------------------------------------------------------------
  const markets = useMemo(() => (marketsQuery.data ?? []).map(marketView), [marketsQuery.data]);
  const market = markets.find((m) => m.symbol === selected) ?? markets[0] ?? null;
  const queuedOrders = useMemo(() => (historyQuery.data?.openOrders ?? []).map(orderView), [historyQuery.data]);
  const trades = useMemo(() => (historyQuery.data?.recentTrades ?? []).map(tradeView), [historyQuery.data]);
  const holdings = useMemo(() => accountView(wallet.isConnected ? stateQuery.data : null, queuedOrders), [wallet.isConnected, stateQuery.data, queuedOrders]);
  // A take-profit or stop-loss belongs to the position it was set on and can never fire once that is closed, so it is listed only while the position exists.
  const orders = useMemo(() => queuedOrders.filter((o) => !o.protective || holdings.positions.some((p) => p.symbol === o.symbol)), [queuedOrders, holdings]);
  const account = holdings;
  const historyError = historyQuery.isError ? (historyQuery.error?.status === 503 ? 'The order database is not configured on this service.' : friendlyError(historyQuery.error)) : '';
  const selectedPosition = account.positions.find((p) => p.symbol === market?.symbol);

  const notify = useCallback((message) => setToast(message), []);
  const changeView = useCallback((item) => {
    setView(item);
    const key = item === 'Solvency' ? 'ledger' : item.toLowerCase();
    const next = new URLSearchParams();
    if (item !== 'Trade') next.set('view', key);
    if (inviteAddress) next.set('ref', inviteAddress);
    window.history.replaceState({}, '', next.size ? `/trade?${next}` : '/trade');
  }, [inviteAddress]);
  const chooseMarket = useCallback((symbol) => { setSelected(symbol); changeView('Trade'); setDialog(null); }, [changeView]);
  const openWallet = useCallback(() => setDialog({ type: 'wallet' }), []);
  const toggleFavorite = useCallback((symbol) => setFavorites((prev) => (prev.includes(symbol) ? prev.filter((v) => v !== symbol) : [...prev, symbol])), [setFavorites]);

  // ---- price alerts (kept in this browser, checked as prices arrive) -------------------------------------------------
  useEffect(() => {
    if (!alerts.length || !markets.length) return;
    const hit = alerts.filter((a) => {
      const price = markets.find((m) => m.symbol === a.symbol)?.price;
      return price && (a.direction === 'Above' ? price >= a.price : price <= a.price);
    });
    if (!hit.length) return;
    setAlerts((prev) => prev.filter((a) => !hit.some((h) => h.id === a.id)));
    notify(hit.map((a) => `${a.symbol} is ${a.direction.toLowerCase()} ${money(a.price, priceDigits(a.price))}`).join(' · '));
  }, [markets]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- page-level behaviour ------------------------------------------------------------------------------------------
  useEffect(() => { if (params().get('view') === 'portfolio') setDialog(wallet.isConnected ? { type: 'account' } : { type: 'wallet' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (market && !selected) setSelected(market.symbol); }, [market, selected]);
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    const shortcut = (event) => {
      const editing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setDialog({ type: 'command' }); return; }
      if (editing || dialog || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '/') { event.preventDefault(); setDialog({ type: 'command' }); }
      if (event.key === '?') { event.preventDefault(); setDialog({ type: 'shortcuts' }); }
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); setFocusMode((v) => !v); }
      if (event.key.toLowerCase() === 'b') { setSideRequest({ side: 'long', n: Date.now() }); changeView('Trade'); }
      if (event.key.toLowerCase() === 's') { setSideRequest({ side: 'short', n: Date.now() }); changeView('Trade'); }
      if (event.key === 'Escape') setFocusMode(false);
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [dialog, changeView]);
  useEffect(() => { if (!toast) return undefined; const timer = setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer); }, [toast]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (workspace.current?.requestFullscreen) await workspace.current.requestFullscreen();
      else { setFocusMode((v) => !v); notify('This browser does not expose full screen. Focus layout is available.'); }
    } catch { setFocusMode(true); notify('Browser full screen is unavailable here. Focus layout enabled.'); }
  }

  const ctx = { wallet, trader, notify, setDialog, setBottomTab, changeView, chooseMarket, openWallet, sideRequest, addAlert: (a) => setAlerts((prev) => [...prev, a]) };

  // ---- connection status for the strip and the Ledger ----------------------------------------------------------------
  const apiDown = marketsQuery.isError && !marketsQuery.data;
  const contractsDown = configQuery.isError;
  const feedDown = markets.length > 0 && markets.every((m) => !m.feedUp);
  const status = apiDown ? { tone: 'bad', text: 'Cannot reach the PlanktonOTC service. Prices and trading are unavailable until it answers.' }
    : contractsDown ? { tone: 'bad', text: 'The exchange contracts are not deployed on this network yet. Markets are listed but cannot trade.' }
    : wallet.wrongNetwork ? { tone: 'warn', text: 'Your wallet is on another network. Switch to Robinhood Chain to trade.' }
    : feedDown ? { tone: 'warn', text: 'The live price feed is not answering. New positions are paused; exits stay available at the on-chain mark.' }
    : !markets.length && marketsQuery.isLoading ? { tone: 'muted', text: 'Connecting to the exchange…' }
    : { tone: 'good', text: `Robinhood Chain · ${markets.length} market${markets.length === 1 ? '' : 's'} · marks are signed by independent signers and checked against Chainlink where a feed exists. Synthetic perpetuals: no shares are delivered.` };
  const health = [
    ['PlanktonOTC service', !apiDown, 'Unreachable'],
    ['Price feeds', markets.length > 0 && !feedDown, 'Not answering'],
    ['Exchange contracts', !contractsDown && configQuery.isSuccess, contractsDown ? 'Not deployed' : 'Loading'],
    ['Order database', !historyQuery.isError || !wallet.isConnected, 'Not configured'],
  ];

  const visibleMarkets = markets.filter((m) => (!favoritesOnly || favorites.includes(m.symbol)) && `${m.symbol} ${m.name}`.toLowerCase().includes(search.toLowerCase()));
  const dialogMarket = (symbol) => markets.find((m) => m.symbol === symbol) ?? market;

  return (
    <Terminal.Provider value={ctx}>
      <div className={`terminal ${focusMode ? 'term-focus' : ''}`} ref={workspace}>
        <header className="term-nav">
          <a className="term-brand" href="/" aria-label={tr('PLANKTON homepage')}><img src="/assets/plankton-logo.png" alt="" /><span>PLANKTON</span></a>
          <nav aria-label={tr('Terminal navigation')}>
            {['Trade', 'Counter', 'Tape', 'Leaderboard', 'Solvency', 'Rewards', 'Referrals'].map((item) => <button key={item} className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => changeView(item)}>{tr(item)}</button>)}
            <a href="/docs">{tr('Guide')} <Arrow /></a>
            <LangSwitch className="lang-switch--terminal lang-switch--nav" />
          </nav>
          <div className="term-workspace-controls">
            <LangSwitch className="lang-switch--terminal" />
            <button aria-label={tr('Search markets and commands')} title={tr('Search (Ctrl K)')} onClick={() => setDialog({ type: 'command' })}>⌕ <kbd>⌘ K</kbd></button>
            <button className={focusMode ? 'active' : ''} aria-pressed={focusMode} aria-label={focusMode ? tr('Exit focus layout') : tr('Enter focus layout')} title={tr('Focus layout (F)')} onClick={() => setFocusMode((v) => !v)}>▣</button>
            <button className={fullscreen ? 'active' : ''} aria-pressed={fullscreen} aria-label={fullscreen ? tr('Exit browser full screen') : tr('Enter browser full screen')} onClick={toggleFullscreen}>⛶</button>
            <button aria-label={tr('Keyboard shortcuts')} onClick={() => setDialog({ type: 'shortcuts' })}>?</button>
            {wallet.isConnected
              ? <button className={`term-demo-account-button term-wallet-button ${wallet.wrongNetwork ? 'is-wrong' : ''}`} onClick={() => (wallet.wrongNetwork ? wallet.switchNetwork().catch((e) => notify(friendlyError(e))) : setDialog({ type: 'account' }))}><i />{wallet.wrongNetwork ? tr('Switch network') : shortAddress(wallet.address)}</button>
              : <button className="term-demo-account-button term-wallet-button is-cta" onClick={openWallet}><i />{PRIVY_APP_ID ? tr('Sign in') : tr('Connect wallet')}</button>}
          </div>
        </header>
        <div className={`term-preview-strip term-status-${status.tone}`}><span><i /> {tr(status.tone === 'good' ? 'LIVE' : status.tone === 'muted' ? 'CONNECTING' : 'ATTENTION')}</span><p>{tr(status.text)}</p><a href="/docs?topic=risk">{tr('Know the risks')} ↗</a></div>

        {view === 'Trade' && (
          <>
            <div className="term-account-strip">
              <span>{tr('Account equity')} <b>{wallet.isConnected ? money(account.equity) : '—'}<small>USDG</small></b></span>
              <span>{tr('Available USDG')} <b>{wallet.isConnected ? money(account.available) : '—'}</b></span>
              <span>{tr('Position PnL')} <b className={account.pnl >= 0 ? 'term-positive' : 'term-negative'}>{wallet.isConnected ? signed(account.pnl) : '—'}</b></span>
              <span>{tr('Gross exposure')} <b>{wallet.isConnected ? money(account.exposure) : '—'}</b></span>
              <span>{tr('Reserved margin')} <b>{wallet.isConnected ? money(account.reserved) : '—'}</b></span>
              <button onClick={() => (wallet.isConnected ? setDialog({ type: 'account' }) : openWallet())}>{wallet.isConnected ? tr('Account & deposits') : tr('Connect wallet')} <Arrow /></button>
            </div>
            <main className="term-workspace">
              <aside className="term-markets">
                <div className="term-panel-heading"><h2>{tr('Markets')}</h2><span>{String(markets.length).padStart(2, '0')}</span></div>
                <label className="term-search"><span aria-hidden="true">⌕</span><input aria-label={tr('Search markets')} placeholder={tr('Search markets')} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
                <div className="term-watch-tabs">
                  <button aria-pressed={!favoritesOnly} className={!favoritesOnly ? 'active' : ''} onClick={() => setFavoritesOnly(false)}>{tr('All markets')}</button>
                  <button aria-pressed={favoritesOnly} className={favoritesOnly ? 'active' : ''} onClick={() => setFavoritesOnly(true)}>★ {tr('Watchlist')} <span>{favorites.length}</span></button>
                </div>
                <div className="term-market-labels"><span>{tr('PERPETUALS')}</span><span>{tr('MARK / VS CLOSE')}</span></div>
                <div className="term-market-list">
                  {visibleMarkets.map((m) => <MarketTile key={m.symbol} market={m} selected={market?.symbol === m.symbol} favorite={favorites.includes(m.symbol)} onSelect={setSelected} onFavorite={toggleFavorite} />)}
                  {!visibleMarkets.length && <div className="term-empty">{tr(marketsQuery.isLoading ? 'Loading markets…' : apiDown ? 'Markets unavailable.' : favoritesOnly ? 'No matching favorites.' : 'No markets found.')}{(favoritesOnly || search) && <button className="term-text-button" onClick={() => { setSearch(''); setFavoritesOnly(false); }}>{tr('Show all markets')}</button>}</div>}
                </div>
                <div className="term-market-foot">
                  <span className="term-overline">{tr('SOURCE STATUS')}</span>
                  <div className="term-feed-state"><i className={feedDown || apiDown ? 'is-off' : 'is-on'} />{tr(apiDown ? 'Service unreachable' : feedDown ? 'Feeds not answering' : 'Feeds connected')}</div>
                  <p>{tr("Every mark is signed by independent signers. Where Chainlink has a feed it must agree with Robinhood's quote before a new position can open.")}</p>
                  <button className="term-text-button" disabled={!market} onClick={() => setDialog({ type: 'sources', symbol: market?.symbol })}>{tr('Inspect pricing sources')} ↗</button>
                  <a href="/#roadmap">{tr('Explore the roadmap')} <Arrow /></a>
                </div>
              </aside>
              {market ? (
                <>
                  <section className="term-center">
                    <div className="term-market-header">
                      <div>
                        <CompanyMark symbol={market.symbol} name={market.name} className="term-selected-company" />
                        <div><h1>{market.symbol}<small>/ USDG</small></h1><p>{market.name} <span>{tr(market.classLabel)}</span></p></div>
                      </div>
                      <div className="term-mark-price">
                        <strong>{market.price ? money(market.price, priceDigits(market.price)) : '—'}</strong>
                        {market.change !== null ? <span className={market.change >= 0 ? 'term-positive' : 'term-negative'}>{market.change >= 0 ? '+' : ''}{market.change.toFixed(2)}% {tr('vs close')} <Arrow down={market.change < 0} /></span> : <span className="term-muted">{tr(market.statusLabel)}</span>}
                      </div>
                      <div className="term-market-stat"><span>{tr('State')}</span><strong>{tr(market.statusLabel)}</strong></div>
                      <div className="term-market-stat"><span>{tr('Max leverage')}</span><strong>{market.limits && market.limits.maxLeverage > 0 ? `${market.limits.maxLeverage}×` : '—'}</strong></div>
                      <div className="term-market-stat"><span>{tr('Open interest')}</span><strong>{market.limits ? compact(market.limits.longOi + market.limits.shortOi) : '—'}</strong></div>
                    </div>
                    <div className="term-chart-tools">
                      <span className="term-overline">{tr('LEVELS · 1H CHART')}</span>
                      <button className="term-text-button" onClick={() => setDialog({ type: 'alert' })}>♧ {tr('Alert')}</button>
                      <span className={`term-state-badge state-${market.status}`}><i />{tr(market.statusLabel)}</span>
                    </div>
                    <Chart market={market} position={selectedPosition} orders={orders} />
                    <div className="term-source-bar">
                      <span><i className={market.status === 'open' || market.status === 'extended' ? 'good' : 'muted'} />{market.status === 'open' || market.status === 'extended' ? tr(market.sources.length > 1 ? 'Two-source mark' : 'Robinhood-quote mark') : tr('{state} mark', { state: tr(market.statusLabel) })}{market.dispersionBps !== null && market.sources.length > 1 ? ` · ${tr('{bps} bps apart', { bps: market.dispersionBps })}` : ''}</span>
                      <span>{tr('Spread')} <b>{market.limits ? `${market.limits.openSpreadBps} bps` : '—'}</b></span>
                      <span>{tr(market.canOpen ? 'Max position' : 'New opens')} <b>{market.canOpen ? `${money(market.limits.positionCap, 0)} USDG` : tr('Unavailable')}</b></span>
                      <button onClick={() => setDialog({ type: 'sources', symbol: market.symbol })}>{tr('Why this mark?')} ↗</button>
                    </div>
                    {market.status !== 'open' && <div className="term-session-notice">{tr(market.blockers[0] ?? market.statusNote)}</div>}
                    {market.status === 'open' && market.blockers.length > 0 && <div className="term-session-notice">{tr(market.blockers[0])}</div>}
                    <Positions account={account} orders={orders} trades={trades} historyError={historyError} tab={bottomTab} setTab={setBottomTab} />
                  </section>
                  <Ticket market={market} account={account} orders={orders} />
                </>
              ) : (
                <section className="term-center term-center-empty">
                  <div className="term-empty">{tr(marketsQuery.isLoading ? 'Loading markets…' : apiDown ? 'The PlanktonOTC service is not answering.' : 'No markets are listed yet.')}<small>{tr(apiDown ? 'Check that the API is running and the site points at it (see web/.env.example).' : 'Markets appear here as soon as they are enabled.')}</small></div>
                </section>
              )}
            </main>
          </>
        )}
        <div className="term-view-shell" hidden={view !== 'Counter'}><CounterView account={account} /></div>
        <div className="term-view-shell" hidden={view !== 'Tape'}><TapeView markets={markets} alerts={alerts} removeAlert={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))} favorites={favorites} toggleFavorite={toggleFavorite} /></div>
        <div className="term-view-shell" hidden={view !== 'Leaderboard'}><LeaderboardView active={view === 'Leaderboard'} /></div>
        <div className="term-view-shell" hidden={view !== 'Solvency'}><LedgerView health={health} /></div>
        <div className="term-view-shell" hidden={view !== 'Rewards'}><RewardsView /></div>
        <div className="term-view-shell" hidden={view !== 'Referrals'}><ReferralsView contracts={configQuery.data?.contracts} inviteAddress={inviteAddress} /></div>

        <footer className="term-footer"><span><i /> {tr(status.tone === 'good' ? 'LIVE' : 'OFFLINE')}</span><p>{tr('$PLKT is live on Robinhood Chain. Synthetic perpetuals confer no share ownership.')}</p><div><a href="/docs?topic=risk">{tr('Risk')}</a><a href="/docs?topic=terms">{tr('Terms')}</a><a href="/">{tr('Back to PLANKTON')} ↗</a></div></footer>
        {toast && <div className="term-toast" role="status"><span>✓</span>{tr(toast)}<button aria-label={tr('Dismiss notification')} onClick={() => setToast('')}>×</button></div>}

        {dialog?.type === 'command' && <CommandMenu markets={markets} />}
        {dialog?.type === 'shortcuts' && <ShortcutsDialog />}
        {dialog?.type === 'wallet' && <WalletDialog />}
        {dialog?.type === 'account' && <AccountDialog account={account} />}
        {dialog?.type === 'close' && <CloseDialog symbol={dialog.symbol} percent={dialog.percent} account={account} market={dialogMarket(dialog.symbol)} />}
        {dialog?.type === 'close-at-mark' && <CloseAtMarkDialog symbol={dialog.symbol} percent={dialog.percent} account={account} market={dialogMarket(dialog.symbol)} />}
        {dialog?.type === 'margin' && <MarginDialog symbol={dialog.symbol} account={account} />}
        {dialog?.type === 'protection' && <ProtectionDialog symbol={dialog.symbol} account={account} orders={orders} market={dialogMarket(dialog.symbol)} />}
        {dialog?.type === 'cancel-order' && <CancelOrderDialog nonce={dialog.nonce} orders={orders} />}
        {dialog?.type === 'risk' && <RiskDialog symbol={dialog.symbol} account={account} />}
        {dialog?.type === 'sources' && market && <SourcesDialog market={dialogMarket(dialog.symbol)} />}
        {dialog?.type === 'capacity' && market && <CapacityDialog market={market} />}
        {dialog?.type === 'alert' && market && <AlertDialog market={market} />}
      </div>
    </Terminal.Provider>
  );
}

export default function Dashboard() {
  return <Providers><TerminalApp /></Providers>;
}
