import React, { useEffect, useRef, useState } from 'react';
import { TV_SYMBOLS } from './shared.jsx';
import { protectionFor } from '../live/model.js';
import { money, priceDigits } from '../live/units.js';

/**
 * The underlying stock's chart from TradingView's free embed (no price history is stored by PlanktonOTC). The widget shows
 * the real stock, not PlanktonOTC's own price line, so the strip underneath carries the mark and the trader's own levels.
 */
function TradingView({ symbol }) {
  const host = useRef(null);
  const [failed, setFailed] = useState(false);
  const tv = TV_SYMBOLS[symbol] ?? symbol;
  useEffect(() => {
    const node = host.current;
    if (!node) return undefined;
    setFailed(false);
    node.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    inner.style.height = '100%';
    node.appendChild(inner);
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.text = JSON.stringify({
      autosize: true,
      symbol: tv,
      interval: '60',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      backgroundColor: '#111416',
      gridColor: 'rgba(255, 255, 255, 0.05)',
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      hide_side_toolbar: true,
      support_host: 'https://www.tradingview.com',
    });
    node.appendChild(script);
    // An ad blocker or an offline machine leaves the container empty: say so rather than show a blank box.
    const timer = setTimeout(() => { if (!node.querySelector('iframe')) setFailed(true); }, 10_000);
    return () => { clearTimeout(timer); node.innerHTML = ''; };
  }, [tv]);
  return (
    <div className="term-tv">
      <div className="tradingview-widget-container term-tv-host" ref={host} />
      {failed && <div className="term-tv-fallback" role="status"><strong>The chart could not load.</strong><span>TradingView is blocked or offline. Prices and trading still work.</span><a href={`https://www.tradingview.com/symbols/${tv.replace(':', '-')}/`} target="_blank" rel="noreferrer">Open {symbol} on TradingView ↗</a></div>}
    </div>
  );
}

export default function Chart({ market, position, orders }) {
  const digits = priceDigits(market.price || 1);
  const prot = protectionFor(market.symbol, orders);
  const levels = [
    ['MARK', market.price, 'mark'],
    ...(position ? [['ENTRY', position.entry, 'entry']] : []),
    ...(prot.takeProfit ? [['TAKE PROFIT', prot.takeProfit.trigger, 'tp']] : []),
    ...(prot.stopLoss ? [['STOP LOSS', prot.stopLoss.trigger, 'sl']] : []),
    ...(position?.liquidation ? [['LIQ. EST.', position.liquidation, 'liq']] : []),
  ];
  return (
    <div className="term-chart term-chart-live">
      <div className="term-ohlc"><span>{market.symbol} · UNDERLYING STOCK</span><em>CHART BY TRADINGVIEW</em></div>
      <TradingView symbol={market.symbol} />
      <div className="term-levels" aria-label="PlanktonOTC price levels">
        {levels.map(([label, value, kind]) => <span key={label} className={`lvl-${kind}`}><i />{label}<b>{value ? money(value, digits) : '—'}</b></span>)}
        <small>The chart shows the real stock. PlanktonOTC fills at its own mark, shown first.</small>
      </div>
    </div>
  );
}
