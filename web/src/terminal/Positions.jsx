import React from 'react';
import { useTerminal } from './shared.jsx';
import { protectionFor, relativeTime } from '../live/model.js';
import { explorerTx } from '../live/wagmi.js';
import { money, priceDigits, signed } from '../live/units.js';

export default function Positions({ account, orders, trades, historyError, tab, setTab }) {
  const t = useTerminal();
  const connected = t.wallet.isConnected;
  const counts = { Positions: account.positions.length, 'Open orders': orders.length, History: trades.length };
  const empty = !connected
    ? { text: 'Connect a wallet to see your positions.', hint: 'Your positions and orders are read from the exchange contract for your address.', action: <button className="term-text-button" onClick={t.openWallet}>Connect wallet</button> }
    : tab === 'Positions' && !account.positions.length
      ? { text: 'No open positions.', hint: 'Use the ticket to open one.' }
      : tab === 'Open orders' && !orders.length
        ? { text: historyError ? 'Orders are unavailable right now.' : 'No pending orders.', hint: historyError ? historyError : 'Choose Limit or Stop in the ticket, or set TP / SL on a position.' }
        : tab === 'History' && !trades.length
          ? { text: historyError ? 'History is unavailable right now.' : 'No trades yet.', hint: historyError ? historyError : 'Your fills and closes appear here after the indexer sees them.' }
          : null;

  return (
    <div className="term-positions">
      <div className="term-bottom-tabs" role="group" aria-label="Account table">
        {['Positions', 'Open orders', 'History'].map((item) => (
          <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)} aria-pressed={tab === item}>{item}<span>{connected ? counts[item] : 0}</span></button>
        ))}
      </div>
      <div className="term-table-wrap">
        {connected && tab === 'Positions' && account.positions.length > 0 && (
          <table>
            <thead><tr><th>Market / Side</th><th>Size / Margin</th><th>Entry / Mark</th><th>PnL</th><th>Protection / Risk</th><th>Actions</th></tr></thead>
            <tbody>
              {account.positions.map((p) => {
                const prot = protectionFor(p.symbol, orders);
                const digits = priceDigits(p.mark || p.entry);
                return (
                  <tr key={p.marketId}>
                    <td><strong>{p.symbol}</strong><small className={p.side === 'long' ? 'term-positive' : 'term-negative'}>{p.side.toUpperCase()} · {money(p.leverage, 1)}x</small></td>
                    <td>{money(p.notional)}<small>{money(p.margin)} USDG</small></td>
                    <td>{money(p.entry, digits)}<small>{money(p.mark, digits)}</small></td>
                    <td className={p.pnl >= 0 ? 'term-positive' : 'term-negative'}>{signed(p.pnl)}<small>{signed(p.pnlPercent)}%</small></td>
                    <td>
                      <button className="term-protection-link" onClick={() => t.setDialog({ type: 'protection', symbol: p.symbol })}>
                        {prot.takeProfit || prot.stopLoss ? `TP ${prot.takeProfit ? money(prot.takeProfit.trigger, digits) : '—'} / SL ${prot.stopLoss ? money(prot.stopLoss.trigger, digits) : '—'}` : '+ Set TP / SL'}
                      </button>
                      <button className="term-risk-link" onClick={() => t.setDialog({ type: 'risk', symbol: p.symbol })}>Liq. {p.liquidation === null ? '—' : money(p.liquidation, digits)} · inspect</button>
                    </td>
                    <td>
                      <div className="term-row-actions">
                        <button onClick={() => t.setDialog({ type: 'close', symbol: p.symbol, percent: 25 })}>Trim</button>
                        <button onClick={() => t.setDialog({ type: 'close', symbol: p.symbol, percent: 100 })}>Close</button>
                        <button aria-label={`Add margin to ${p.symbol}`} onClick={() => t.setDialog({ type: 'margin', symbol: p.symbol })}>+</button>
                      </div>
                      <button className="term-fallback" onClick={() => t.setDialog({ type: 'close-at-mark', symbol: p.symbol })}>Close at mark ↗</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {connected && tab === 'Open orders' && orders.length > 0 && (
          <table>
            <thead><tr><th>Market</th><th>Type / Side</th><th>Trigger</th><th>Size</th><th>Reserved margin</th><th>Expires</th><th>Action</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.nonceText}>
                  <td><strong>{o.symbol}</strong></td>
                  <td>{o.label}<small>{o.protective ? 'CLOSES POSITION' : o.side.toUpperCase()}</small></td>
                  <td>{o.triggerAbove ? '≥' : '≤'} {money(o.trigger, priceDigits(o.trigger))}</td>
                  <td>{o.quantity === null ? 'Whole position' : money(o.quantity, 4)}</td>
                  <td>{o.protective ? '—' : money(o.margin)}</td>
                  <td>{relativeTime(o.expiresAt)}</td>
                  <td><div className="term-row-actions"><button className="term-mini-btn" onClick={() => t.setDialog({ type: 'cancel-order', nonce: o.nonceText })}>Cancel</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {connected && tab === 'History' && trades.length > 0 && (
          <table>
            <thead><tr><th>Market</th><th>Event</th><th>Notional</th><th>Price</th><th>Realised PnL</th><th>When</th></tr></thead>
            <tbody>
              {trades.map((x) => (
                <tr key={x.id}>
                  <td><strong>{x.symbol}</strong><small>{x.side.toUpperCase()}</small></td>
                  <td>{x.liquidation ? 'Liquidated' : x.path}<small>fee {money(x.fee)} USDG</small></td>
                  <td>{money(x.notional)}</td>
                  <td>{money(x.price, priceDigits(x.price))}</td>
                  <td className={x.pnl > 0 ? 'term-positive' : x.pnl < 0 ? 'term-negative' : ''}>{x.pnl === 0 ? '—' : signed(x.pnl)}</td>
                  <td><a className="term-table-tag" href={explorerTx(x.txHash)} target="_blank" rel="noreferrer">{relativeTime(x.at)} ↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {empty && <div className="term-empty">{empty.text}<small>{empty.hint}</small>{empty.action}</div>}
    </div>
  );
}
