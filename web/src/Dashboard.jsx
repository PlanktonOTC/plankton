import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Providers from './live/Providers.jsx';
import { useAccountHistory, useAccountState, useConfig, useMarkets } from './live/queries.js';
import { useTrader, useWallet } from './live/useTrader.js';
import { accountView, marketView, orderView, tradeView } from './live/model.js';
import { friendlyError } from './live/errors.js';
import { compact, money, priceDigits, shortAddress, signed } from './live/units.js';
import { Arrow, Terminal, useStored } from './terminal/shared.jsx';
import Chart from './terminal/Chart.jsx';
import Positions from './terminal/Positions.jsx';
import Ticket from './terminal/Ticket.jsx';
import { CounterView, LedgerView, RewardsView, TapeView } from './terminal/Views.jsx';
import { AccountDialog, AlertDialog, CancelOrderDialog, CapacityDialog, CloseAtMarkDialog, CloseDialog, CommandMenu, MarginDialog, ProtectionDialog, RiskDialog, ShortcutsDialog, SourcesDialog, WalletDialog } from './terminal/Dialogs.jsx';
import MarketTile, { CompanyMark } from './MarketRail';
import './dashboard.css';
import './supporting-metal.css';
import './terminal/live.css';

const VIEWS = { counter: 'Counter', tape: 'Tape', ledger: 'Ledger', rewards: 'Rewards' };
const params = () => new URLSearchParams(window.location.search);

function TerminalApp() {
  const workspace = useRef(null);
  const wallet = useWallet();
  const configQuery = useConfig();
  const marketsQuery = useMarkets();
  const stateQuery = useAccountState(wallet.isConnected ? wallet.address : undefined);
  const historyQuery = useAccountHistory(wallet.isConnected ? wallet.address : undefined);
  const trader = useTrader(configQuery.data);

  const [view, setView] = useState(() => VIEWS[params().get('view')] || 'Trade');
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
  const orders = useMemo(() => (historyQuery.data?.openOrders ?? []).map(orderView), [historyQuery.data]);
  const trades = useMemo(() => (historyQuery.data?.recentTrades ?? []).map(tradeView), [historyQuery.data]);
  const account = useMemo(() => accountView(wallet.isConnected ? stateQuery.data : null, orders), [wallet.isConnected, stateQuery.data, orders]);
  const historyError = historyQuery.isError ? (historyQuery.error?.status === 503 ? 'The order database is not configured on this service.' : friendlyError(historyQuery.error)) : '';
  const selectedPosition = account.positions.find((p) => p.symbol === market?.symbol);

  const notify = useCallback((message) => setToast(message), []);
  const changeView = useCallback((item) => {
    setView(item);
    window.history.replaceState({}, '', item === 'Trade' ? '/trade' : `/trade?view=${item.toLowerCase()}`);
  }, []);
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
          <a className="term-brand" href="/" aria-label="PLANKTON homepage"><img src="/assets/plankton-logo.png" alt="" /><span>PLANKTON</span></a>
          <nav aria-label="Terminal navigation">
            {['Trade', 'Counter', 'Tape', 'Ledger', 'Rewards'].map((item) => <button key={item} className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => changeView(item)}>{item}</button>)}
            <a href="/docs">Guide <Arrow /></a>
          </nav>
          <div className="term-workspace-controls">
            <button aria-label="Search markets and commands" title="Search (Ctrl K)" onClick={() => setDialog({ type: 'command' })}>⌕ <kbd>⌘ K</kbd></button>
            <button className={focusMode ? 'active' : ''} aria-pressed={focusMode} aria-label={focusMode ? 'Exit focus layout' : 'Enter focus layout'} title="Focus layout (F)" onClick={() => setFocusMode((v) => !v)}>▣</button>
            <button className={fullscreen ? 'active' : ''} aria-pressed={fullscreen} aria-label={fullscreen ? 'Exit browser full screen' : 'Enter browser full screen'} onClick={toggleFullscreen}>⛶</button>
            <button aria-label="Keyboard shortcuts" onClick={() => setDialog({ type: 'shortcuts' })}>?</button>
            {wallet.isConnected
              ? <button className={`term-demo-account-button term-wallet-button ${wallet.wrongNetwork ? 'is-wrong' : ''}`} onClick={() => (wallet.wrongNetwork ? wallet.switchNetwork().catch((e) => notify(friendlyError(e))) : setDialog({ type: 'account' }))}><i />{wallet.wrongNetwork ? 'Switch network' : shortAddress(wallet.address)}</button>
              : <button className="term-demo-account-button term-wallet-button" onClick={openWallet}><i />Connect wallet</button>}
          </div>
        </header>
        <div className={`term-preview-strip term-status-${status.tone}`}><span><i /> {status.tone === 'good' ? 'LIVE' : status.tone === 'muted' ? 'CONNECTING' : 'ATTENTION'}</span><p>{status.text}</p><a href="/docs?topic=risk">Know the risks ↗</a></div>

        {view === 'Trade' && (
          <>
            <div className="term-account-strip">
              <span>Account equity <b>{wallet.isConnected ? money(account.equity) : '—'}<small>USDG</small></b></span>
              <span>Available USDG <b>{wallet.isConnected ? money(account.available) : '—'}</b></span>
              <span>Position PnL <b className={account.pnl >= 0 ? 'term-positive' : 'term-negative'}>{wallet.isConnected ? signed(account.pnl) : '—'}</b></span>
              <span>Gross exposure <b>{wallet.isConnected ? money(account.exposure) : '—'}</b></span>
              <span>Reserved margin <b>{wallet.isConnected ? money(account.reserved) : '—'}</b></span>
              <button onClick={() => (wallet.isConnected ? setDialog({ type: 'account' }) : openWallet())}>{wallet.isConnected ? 'Account & deposits' : 'Connect wallet'} <Arrow /></button>
            </div>
            <main className="term-workspace">
              <aside className="term-markets">
                <div className="term-panel-heading"><h2>Markets</h2><span>{String(markets.length).padStart(2, '0')}</span></div>
                <label className="term-search"><span aria-hidden="true">⌕</span><input aria-label="Search markets" placeholder="Search markets" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
                <div className="term-watch-tabs">
                  <button aria-pressed={!favoritesOnly} className={!favoritesOnly ? 'active' : ''} onClick={() => setFavoritesOnly(false)}>All markets</button>
                  <button aria-pressed={favoritesOnly} className={favoritesOnly ? 'active' : ''} onClick={() => setFavoritesOnly(true)}>★ Watchlist <span>{favorites.length}</span></button>
                </div>
                <div className="term-market-labels"><span>PERPETUALS</span><span>MARK / VS CLOSE</span></div>
                <div className="term-market-list">
                  {visibleMarkets.map((m) => <MarketTile key={m.symbol} market={m} selected={market?.symbol === m.symbol} favorite={favorites.includes(m.symbol)} onSelect={setSelected} onFavorite={toggleFavorite} />)}
                  {!visibleMarkets.length && <div className="term-empty">{marketsQuery.isLoading ? 'Loading markets…' : apiDown ? 'Markets unavailable.' : favoritesOnly ? 'No matching favorites.' : 'No markets found.'}{(favoritesOnly || search) && <button className="term-text-button" onClick={() => { setSearch(''); setFavoritesOnly(false); }}>Show all markets</button>}</div>}
                </div>
                <div className="term-market-foot">
                  <span className="term-overline">SOURCE STATUS</span>
                  <div className="term-feed-state"><i className={feedDown || apiDown ? 'is-off' : 'is-on'} />{apiDown ? 'Service unreachable' : feedDown ? 'Feeds not answering' : 'Feeds connected'}</div>
                  <p>Every mark is signed by independent signers. Where Chainlink has a feed it must agree with Robinhood's quote before a new position can open.</p>
                  <button className="term-text-button" disabled={!market} onClick={() => setDialog({ type: 'sources', symbol: market?.symbol })}>Inspect pricing sources ↗</button>
                  <a href="/#roadmap">Explore the roadmap <Arrow /></a>
                </div>
              </aside>
              {market ? (
                <>
                  <section className="term-center">
                    <div className="term-market-header">
                      <div>
                        <CompanyMark symbol={market.symbol} name={market.name} className="term-selected-company" />
                        <div><h1>{market.symbol}<small>/ USDG</small></h1><p>{market.name} <span>{market.classLabel}</span></p></div>
                      </div>
                      <div className="term-mark-price">
                        <strong>{market.price ? money(market.price, priceDigits(market.price)) : '—'}</strong>
                        {market.change !== null ? <span className={market.change >= 0 ? 'term-positive' : 'term-negative'}>{market.change >= 0 ? '+' : ''}{market.change.toFixed(2)}% vs close <Arrow down={market.change < 0} /></span> : <span className="term-muted">{market.statusLabel}</span>}
                      </div>
                      <div className="term-market-stat"><span>State</span><strong>{market.statusLabel}</strong></div>
                      <div className="term-market-stat"><span>Max leverage</span><strong>{market.limits ? `${market.limits.maxLeverage}×` : '—'}</strong></div>
                      <div className="term-market-stat"><span>Open interest</span><strong>{market.limits ? compact(market.limits.longOi + market.limits.shortOi) : '—'}</strong></div>
                    </div>
                    <div className="term-chart-tools">
                      <span className="term-overline">LEVELS · 1H CHART</span>
                      <button className="term-text-button" onClick={() => setDialog({ type: 'alert' })}>♧ Alert</button>
                      <span className={`term-state-badge state-${market.status}`}><i />{market.statusLabel}</span>
                    </div>
                    <Chart market={market} position={selectedPosition} orders={orders} />
                    <div className="term-source-bar">
                      <span><i className={market.status === 'open' || market.status === 'extended' ? 'good' : 'muted'} />{market.status === 'open' || market.status === 'extended' ? (market.sources.length > 1 ? 'Two-source mark' : 'Robinhood-quote mark') : `${market.statusLabel} mark`}{market.dispersionBps !== null && market.sources.length > 1 ? ` · ${market.dispersionBps} bps apart` : ''}</span>
                      <span>Spread <b>{market.limits ? `${market.limits.openSpreadBps} bps` : '—'}</b></span>
                      <span>{market.canOpen ? 'Max position' : 'New opens'} <b>{market.canOpen ? `${money(market.limits.positionCap, 0)} USDG` : 'Unavailable'}</b></span>
                      <button onClick={() => setDialog({ type: 'sources', symbol: market.symbol })}>Why this mark? ↗</button>
                    </div>
                    {market.status !== 'open' && <div className="term-session-notice">{market.blockers[0] ?? market.statusNote}</div>}
                    {market.status === 'open' && market.blockers.length > 0 && <div className="term-session-notice">{market.blockers[0]}</div>}
                    <Positions account={account} orders={orders} trades={trades} historyError={historyError} tab={bottomTab} setTab={setBottomTab} />
                  </section>
                  <Ticket market={market} account={account} orders={orders} />
                </>
              ) : (
                <section className="term-center term-center-empty">
                  <div className="term-empty">{marketsQuery.isLoading ? 'Loading markets…' : apiDown ? 'The PlanktonOTC service is not answering.' : 'No markets are listed yet.'}<small>{apiDown ? 'Check that the API is running and the site points at it (see web/.env.example).' : 'Markets appear here as soon as they are enabled.'}</small></div>
                </section>
              )}
            </main>
          </>
        )}
        <div className="term-view-shell" hidden={view !== 'Counter'}><CounterView account={account} /></div>
        <div className="term-view-shell" hidden={view !== 'Tape'}><TapeView markets={markets} alerts={alerts} removeAlert={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))} favorites={favorites} toggleFavorite={toggleFavorite} /></div>
        <div className="term-view-shell" hidden={view !== 'Ledger'}><LedgerView health={health} /></div>
        <div className="term-view-shell" hidden={view !== 'Rewards'}><RewardsView /></div>

        <footer className="term-footer"><span><i /> {status.tone === 'good' ? 'LIVE' : 'OFFLINE'}</span><p>No token yet. Synthetic perpetuals. No share ownership.</p><div><a href="/docs?topic=risk">Risk</a><a href="/docs?topic=terms">Terms</a><a href="/">Back to PLANKTON ↗</a></div></footer>
        {toast && <div className="term-toast" role="status"><span>✓</span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}>×</button></div>}

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
