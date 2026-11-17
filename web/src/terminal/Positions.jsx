import React, { useState } from 'react';
import { useTerminal } from './shared.jsx';
import { protectionFor, relativeTime } from '../live/model.js';
import { explorerTx } from '../live/wagmi.js';
import { money, priceDigits, signed } from '../live/units.js';
import { downloadTaxReport, downloadTradeHistory, fetchTradeExport } from '../live/tradeExport.js';
import { useI18n } from '../i18n';
import { hasRealizedPnl, sharePnlCard } from '../live/pnlCard.js';

export default function Positions({ account, orders, trades, historyError, tab, setTab }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const currentYear = new Date().getUTCFullYear();
  const [exportYear, setExportYear] = useState(currentYear);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [sharingTrade, setSharingTrade] = useState('');
  const [shareMessage, setShareMessage] = useState('');
  const connected = t.wallet.isConnected;
  const counts = { Positions: account.positions.length, 'Open orders': orders.length, History: trades.length };
  const empty = !connected
    ? { text: 'Connect a wallet to see your positions.', hint: 'Your positions and orders are read from the exchange contract for your address.', action: <button className="term-text-button" onClick={t.openWallet}>{tr('Connect wallet')}</button> }
    : tab === 'Positions' && !account.positions.length
      ? { text: 'No open positions.', hint: 'Use the ticket to open one.' }
      : tab === 'Open orders' && !orders.length
        ? { text: historyError ? 'Orders are unavailable right now.' : 'No pending orders.', hint: historyError ? historyError : 'Choose Limit or Stop in the ticket, or set TP / SL on a position.' }
        : tab === 'History' && !trades.length
          ? { text: historyError ? 'History is unavailable right now.' : 'No trades yet.', hint: historyError ? historyError : 'Your fills and closes appear here after the indexer sees them.' }
          : null;

  return (
    <div className="term-positions">
      <div className="term-bottom-tabs" role="group" aria-label={tr('Account table')}>
        {['Positions', 'Open orders', 'History'].map((item) => (
          <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)} aria-pressed={tab === item}>{tr(item)}<span>{connected ? counts[item] : 0}</span></button>
        ))}
      </div>
      {connected && tab === 'History' && trades.length > 0 && (
        <div className="term-history-export">
          <div><strong>{tr('Download your records')}</strong><small>{tr('Exports all indexed fills, not just these rows. The UTC tax summary includes realized P&L and fees; borrow and cash movements are excluded.')}</small></div>
          <button className="term-secondary" disabled={exporting} onClick={async () => {
            setExporting(true); setExportMessage('');
            try {
              const rows = await fetchTradeExport(t.wallet.address);
              downloadTradeHistory(t.wallet.address, rows);
              setExportMessage(`${rows.length} fills exported.`);
            } catch (error) { setExportMessage(error.message || 'Could not export trade history.'); }
            finally { setExporting(false); }
          }}>{exporting ? tr('Preparing…') : tr('Export all trades CSV')}</button>
          <label>{tr('Tax year (UTC)')}
            <select value={exportYear} onChange={(event) => setExportYear(Number(event.target.value))} disabled={exporting}>
              {Array.from({ length: Math.max(1, currentYear - 2016) }, (_, index) => currentYear - index).map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </label>
          <button className="term-secondary" disabled={exporting} onClick={async () => {
            setExporting(true); setExportMessage('');
            try {
              const rows = await fetchTradeExport(t.wallet.address, exportYear);
              downloadTaxReport(t.wallet.address, exportYear, rows);
              setExportMessage(`${exportYear} summary and ${rows.length} fills exported.`);
            } catch (error) { setExportMessage(error.message || 'Could not prepare the tax summary.'); }
            finally { setExporting(false); }
          }}>{exporting ? tr('Preparing…') : tr('Export tax report CSV')}</button>
          {exportMessage && <small className="term-history-export-status" role="status">{tr(exportMessage)}</small>}
        </div>
      )}
      <div className="term-table-wrap">
        {connected && tab === 'Positions' && account.positions.length > 0 && (
          <table>
            <thead><tr><th>{tr('Market / Side')}</th><th>{tr('Size / Margin')}</th><th>{tr('Entry / Mark')}</th><th>{tr('PnL')}</th><th>{tr('Protection / Risk')}</th><th>{tr('Actions')}</th></tr></thead>
            <tbody>
              {account.positions.map((p) => {
                const prot = protectionFor(p.symbol, orders);
                const digits = priceDigits(p.mark || p.entry);
                return (
                  <tr key={p.marketId}>
                    <td><strong>{p.symbol}</strong><small className={p.side === 'long' ? 'term-positive' : 'term-negative'}>{tr(p.side.toUpperCase())} · {money(p.leverage, 1)}x</small></td>
                    <td>{money(p.notional)}<small>{money(p.margin)} USDG</small></td>
                    <td>{money(p.entry, digits)}<small>{money(p.mark, digits)}</small></td>
                    <td className={p.pnl >= 0 ? 'term-positive' : 'term-negative'}>{signed(p.pnl)}<small>{signed(p.pnlPercent)}%</small></td>
                    <td>
                      <button className="term-protection-link" onClick={() => t.setDialog({ type: 'protection', symbol: p.symbol })}>
                        {prot.takeProfit || prot.stopLoss ? tr('TP {tp} / SL {sl}', { tp: prot.takeProfit ? money(prot.takeProfit.trigger, digits) : '—', sl: prot.stopLoss ? money(prot.stopLoss.trigger, digits) : '—' }) : tr('+ Set TP / SL')}
                      </button>
                      <button className="term-risk-link" onClick={() => t.setDialog({ type: 'risk', symbol: p.symbol })}>{tr('Liq.')} {p.liquidation === null ? '—' : money(p.liquidation, digits)} · {tr('inspect')}</button>
                    </td>
                    <td>
                      <div className="term-row-actions">
                        <button onClick={() => t.setDialog({ type: 'close', symbol: p.symbol, percent: 25 })}>{tr('Trim')}</button>
                        <button onClick={() => t.setDialog({ type: 'close', symbol: p.symbol, percent: 100 })}>{tr('Close')}</button>
                        <button aria-label={tr('Add margin to {symbol}', { symbol: p.symbol })} onClick={() => t.setDialog({ type: 'margin', symbol: p.symbol })}>+</button>
                      </div>
                      <button className="term-fallback" onClick={() => t.setDialog({ type: 'close-at-mark', symbol: p.symbol })}>{tr('Close at mark')} ↗</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {connected && tab === 'Open orders' && orders.length > 0 && (
          <table>
            <thead><tr><th>{tr('Market')}</th><th>{tr('Type / Side')}</th><th>{tr('Trigger')}</th><th>{tr('Size')}</th><th>{tr('Reserved margin')}</th><th>{tr('Expires')}</th><th>{tr('Action')}</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.nonceText}>
                  <td><strong>{o.symbol}</strong></td>
                  <td>{tr(o.kind === 4 && o.startsAt && o.startsAt > Date.now() ? 'Scheduled slice' : o.label, null, 'order type')}<small>{tr(o.protective ? 'CLOSES POSITION' : o.side.toUpperCase())}</small></td>
                  <td>{o.kind === 4 ? (o.startsAt && o.startsAt > Date.now() ? tr('Opens {when}', { when: tr(relativeTime(o.startsAt)) }) : tr('Filling now')) : `${o.triggerAbove ? '≥' : '≤'} ${money(o.trigger, priceDigits(o.trigger))}`}</td>
                  <td>{o.quantity === null ? tr('Whole position') : money(o.quantity, 4)}</td>
                  <td>{o.protective ? '—' : money(o.margin)}</td>
                  <td>{tr(relativeTime(o.expiresAt))}</td>
                  <td><div className="term-row-actions"><button className="term-mini-btn" onClick={() => t.setDialog({ type: 'cancel-order', nonce: o.nonceText })}>{tr('Cancel')}</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {connected && tab === 'History' && trades.length > 0 && (
          <table>
            <thead><tr><th>{tr('Market')}</th><th>{tr('Event')}</th><th>{tr('Notional')}</th><th>{tr('Price')}</th><th>{tr('Realised PnL')}</th><th>{tr('When / proof')}</th><th>{tr('Share')}</th></tr></thead>
            <tbody>
              {trades.map((x) => (
                <tr key={x.id}>
                  <td><strong>{x.symbol}</strong><small>{tr(x.side.toUpperCase())}</small></td>
                  <td>{tr(x.liquidation ? 'Liquidated' : x.path)}<small>{tr('fee {fee} USDG', { fee: money(x.fee) })}</small></td>
                  <td>{money(x.notional)}</td>
                  <td>{money(x.price, priceDigits(x.price))}</td>
                  <td className={x.pnl > 0 ? 'term-positive' : x.pnl < 0 ? 'term-negative' : ''}>{x.pnl === 0 ? '—' : signed(x.pnl)}</td>
                  <td><a className="term-table-tag" href={explorerTx(x.txHash)} target="_blank" rel="noreferrer" title={tr('View on-chain transaction proof')}>{tr(relativeTime(x.at))} ↗</a></td>
                  <td>{hasRealizedPnl(x) ? <button className="term-mini-btn term-share-pnl" disabled={sharingTrade === x.id} onClick={async () => {
                    setSharingTrade(x.id); setShareMessage('');
                    try { setShareMessage(await sharePnlCard(x, t.wallet.address)); }
                    catch (error) { if (error?.name !== 'AbortError') setShareMessage(error.message || 'Could not create the share card.'); }
                    finally { setSharingTrade(''); }
                  }}>{sharingTrade === x.id ? tr('Preparing…') : tr('Share card')} ↗</button> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {shareMessage && tab === 'History' && <small className="term-history-export-status term-share-status" role="status">{shareMessage}</small>}
      {empty && <div className="term-empty">{tr(empty.text)}<small>{tr(empty.hint)}</small>{empty.action}</div>}
    </div>
  );
}
