import React, { useRef } from 'react';
import { useTerminal } from './shared.jsx';
import { money, priceDigits } from '../live/units.js';

/** Brushed-steel sheen follows the pointer, as on the other terminal cards. */
function useSheen() {
  const material = useRef(null);
  const move = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    material.current?.style.setProperty('--steel-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
    material.current?.style.setProperty('--steel-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
  };
  const leave = () => {
    material.current?.style.setProperty('--steel-x', '50%');
    material.current?.style.setProperty('--steel-y', '0%');
  };
  return { material, move, leave };
}

export default function RiskPanel({ position, market }) {
  const t = useTerminal();
  const { material, move, leave } = useSheen();
  if (!position) {
    return (
      <div className="term-risk-panel term-risk-steel" ref={material} onPointerMove={move}>
        <div className="term-risk-instrument-title"><span className="term-risk-glyph">◇</span><div><h3>Isolated margin</h3><small>{market.symbol} / USDG</small></div></div>
        <div className="term-risk-no-position"><strong>—</strong><span>No open position</span></div>
        <p>Each position uses its own margin. Fill in the ticket to see the estimated liquidation level before you confirm.</p>
      </div>
    );
  }
  const p = position;
  const digits = priceDigits(p.mark || p.entry);
  return (
    <div className={`term-risk-panel term-risk-steel ${p.buffer <= 0 ? 'is-danger' : ''}`} ref={material} onPointerMove={move} onPointerLeave={leave}>
      <div className="term-risk-instrument-title">
        <span className="term-risk-glyph">◇</span>
        <div><h3>Isolated margin</h3><small>{market.symbol} · {p.side.toUpperCase()} · {money(p.leverage, 1)}×</small></div>
        <button onClick={() => t.setDialog({ type: 'risk', symbol: p.symbol })} aria-label={`Inspect ${market.symbol} margin`}>↗</button>
      </div>
      <div className="term-risk-buffer"><span>Equity above maintenance</span><strong key={p.buffer.toFixed(2)}>{money(p.buffer)}<small>USDG</small></strong></div>
      <div className="term-risk-meter" aria-label={`${money(p.healthPercent, 1)} percent of position equity above maintenance`}>
        {Array.from({ length: 24 }, (_, i) => <i key={i} className={i < Math.round((p.healthPercent / 100) * 24) ? 'filled' : ''} style={{ '--segment': i }} />)}
      </div>
      <div className="term-risk-meter-labels"><span>{p.status}</span><b>{money(p.healthPercent, 1)}%</b></div>
      <dl className="term-risk-grid">
        <div><dt>Position equity</dt><dd>{money(p.equity)}<small>USDG</small></dd></div>
        <div><dt>Maintenance · {money(p.maintenanceBps / 100, 1)}%</dt><dd>{money(p.maintenance)}<small>USDG</small></dd></div>
        <div><dt>Estimated liquidation</dt><dd>{p.liquidation === null ? '—' : money(p.liquidation, digits)}</dd></div>
        <div><dt>Distance to estimate</dt><dd>{p.distancePercent === null ? '—' : money(p.distancePercent, 1)}<small>%</small></dd></div>
      </dl>
      <div className="term-risk-actions">
        <button onClick={() => t.setDialog({ type: 'margin', symbol: p.symbol })}>Add margin <span>+</span></button>
        <button onClick={() => t.setDialog({ type: 'protection', symbol: p.symbol })}>TP / SL <span>↗</span></button>
      </div>
      <small className="term-risk-model-note">Estimate from the contract's maintenance rate. Borrow accrued since opening also counts on-chain.</small>
    </div>
  );
}
