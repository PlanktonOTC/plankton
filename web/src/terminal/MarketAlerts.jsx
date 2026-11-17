import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCatalysts, useHalts } from '../live/queries.js';
import { marketAlerts } from '../live/market-alerts.js';
import { useI18n } from '../i18n';

const PREFERENCE_KEY = 'plankton.market-alerts.enabled';

export default function MarketAlerts({ symbol, active }) {
  const { t: tr } = useI18n();
  const halts = useHalts(active);
  const catalysts = useCatalysts(active);
  const alerts = useMemo(() => marketAlerts(symbol, halts.data, catalysts.data), [symbol, halts.data, catalysts.data]);
  const seen = useRef({ symbol: null, ids: new Set() });
  const [enabled, setEnabled] = useState(() => {
    try { return window.localStorage.getItem(PREFERENCE_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    if (!active || (!halts.isSuccess && !catalysts.isSuccess)) return;
    if (seen.current.symbol !== symbol) {
      seen.current = { symbol, ids: new Set(alerts.map((item) => item.id)) };
      return;
    }
    const added = alerts.filter((item) => !seen.current.ids.has(item.id));
    seen.current = { symbol, ids: new Set(alerts.map((item) => item.id)) };
    if (!enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    for (const item of added) {
      const title = item.kind === 'halt' ? tr('Trading halt: {symbol}', { symbol }) : tr('Stock split pending: {symbol}', { symbol });
      new Notification(title, { body: item.kind === 'halt' ? tr(item.data.reason || 'Nasdaq reported a trading halt.') : tr('A stock split is pending for this market.') });
    }
  }, [active, alerts, catalysts.isSuccess, enabled, halts.isSuccess, symbol, tr]);

  async function enableAlerts() {
    if (!('Notification' in window)) return;
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    const allow = permission === 'granted';
    setEnabled(allow);
    try { window.localStorage.setItem(PREFERENCE_KEY, allow ? '1' : '0'); } catch { /* browser storage can be disabled */ }
  }

  return (
    <section className={`term-market-alerts ${alerts.length ? 'has-alerts' : ''}`} aria-label={tr('Halt and corporate action alerts for {symbol}', { symbol })}>
      <div className="term-market-alerts-content">
        {alerts.length ? alerts.map((item) => <article key={item.id}>
          <strong>{item.kind === 'halt' ? tr('Nasdaq trading halt') : tr('Pending stock split')}</strong>
          <span>{item.kind === 'halt'
            ? `${tr(item.data.reason || 'Trading is halted.')} · ${new Date(item.data.startedAt).toLocaleString()}`
            : `${item.data.status} · ${item.data.processDate || tr('Date not provided')}`}</span>
        </article>) : <p>{tr('No active Nasdaq halt or pending split is reported for this market.')}</p>}
      </div>
      <button type="button" onClick={enableAlerts} disabled={enabled || !('Notification' in window)}>
        {enabled ? tr('Browser alerts enabled') : tr('Enable browser alerts')}
      </button>
    </section>
  );
}
