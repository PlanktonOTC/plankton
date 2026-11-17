import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Header, Footer } from './App';
import { useI18n } from './i18n';
import './feed.css';

// The public Plankton price feed page. It reads /api/v1/feed, which reads MarkOracle on Robinhood Chain.
const REFRESH_MS = 5000;

export function ageText(sec, t = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => vars[k]) : text)) {
  if (sec === null || sec === undefined) return t('never');
  if (sec < 90) return t('{n}s ago', { n: sec });
  if (sec < 5400) return t('{n} min ago', { n: Math.round(sec / 60) });
  if (sec < 172800) return t('{n} h ago', { n: Math.round(sec / 3600) });
  return t('{n} days ago', { n: Math.round(sec / 86400) });
}

function useFeed() {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/v1/feed', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`The feed answered HTTP ${res.status}`);
        const data = await res.json();
        if (alive) setState({ data, error: null, loading: false });
      } catch (err) {
        if (alive) setState((s) => ({ data: s.data, error: err.message || 'Could not reach the feed', loading: false }));
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return state;
}

function CopyButton({ text, label = 'Copy' }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      const box = document.createElement('textarea'); box.value = text; document.body.appendChild(box); box.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      box.remove();
    }
    setDone(true); setTimeout(() => setDone(false), 1500);
  };
  return <button type="button" className="feed-copy" onClick={copy}>{done ? t('Copied ✓') : t(label)}</button>;
}

function Snippets({ data, symbol }) {
  const { t } = useI18n();
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const row = data?.markets.find((m) => m.symbol === symbol) ?? data?.markets[0];
  const snippets = useMemo(() => {
    if (!data || !row) return [];
    const endpoint = `${origin}/api/v1/feed/${row.symbol}`;
    return [
      ['curl', `curl -i '${endpoint}'\n\n# Revalidate with the ETag from the previous response:\ncurl -i -H 'If-None-Match: "<etag>"' '${endpoint}'`],
      ['JavaScript', `const url = '${endpoint}';\nlet etag;\n\nasync function read${row.symbol}() {\n  const res = await fetch(url, { headers: etag ? { 'If-None-Match': etag } : {} });\n  if (res.status === 304) return console.log('${row.symbol} unchanged');\n  if (!res.ok) throw new Error(\`Feed HTTP \${res.status}\`);\n  etag = res.headers.get('ETag');\n  const { market } = await res.json();\n  console.log(market.price, market.ageSec, market.fresh, market.status);\n}\n\nawait read${row.symbol}();`],
      [t('Solidity (on-chain)'), `// Chain ${data.chainId}. Oracle: ${data.oracle}\nIMarkOracle.Mark memory m = IMarkOracle(${data.oracle}).markOf(\n    ${row.marketId}\n); // ${row.symbol}\n// m.priceE18 (18 decimals), m.updatedAt, m.status, m.confidenceBps`],
    ];
  }, [data, row, origin]);
  const [tab, setTab] = useState(0);
  if (!snippets.length) return null;
  const [, code] = snippets[tab];
  return (
    <div className="feed-code">
      <div className="feed-code-tabs" role="tablist" aria-label={t('Code example')}>
        {snippets.map(([name], i) => <button key={name} role="tab" aria-selected={tab === i} className={tab === i ? 'active' : ''} onClick={() => setTab(i)}>{name}</button>)}
        <CopyButton text={code} />
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export default function Feed() {
  const { t } = useI18n();
  const { data, error, loading } = useFeed();
  const [symbol, setSymbol] = useState(null);
  const codeRef = useRef(null);
  const pick = (sym) => {
    setSymbol(sym);
    // The code is below the table, so bring it into view: otherwise a click seems to do nothing.
    requestAnimationFrame(() => codeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const endpoint = `${origin}/api/v1/feed`;
  const markets = data?.markets ?? [];
  const selected = symbol ?? markets[0]?.symbol;
  return (
    <div className="marketing feed-page">
      <Header />
      <main className="feed-main wrap">
        <span className="eyebrow">{t('PLANKTON PRICE FEED')}</span>
        <h1>{t('On-chain prices')}<br />{t('for small caps.')}</h1>
        <p className="feed-lead">{t('The latest price each Plankton market holds on Robinhood Chain, read straight from the oracle contract. Free to use, no key needed, open to any website or script. Single-market lookups read only that market, with ETags for lightweight revalidation.')}</p>

        <div className="feed-endpoint">
          <code>GET {endpoint}</code>
          <CopyButton text={endpoint} label="Copy URL" />
        </div>

        {error && <p className="feed-error" role="alert">{data ? t('Showing the last good data. {error}.', { error }) : t('{error}. Try again in a moment.', { error })}</p>}

        <div className="feed-table-wrap">
          <table className="feed-table">
            <thead><tr><th>{t('Market')}</th><th>{t('Price (USD)')}</th><th>{t('State')}</th><th title={t('How far apart the price sources were. Smaller is better.')}>{t('Uncertainty')}</th><th>{t('Last on-chain update')}</th></tr></thead>
            <tbody>
              {loading && !data && <tr><td colSpan="5" className="feed-empty">{t('Loading prices…')}</td></tr>}
              {markets.map((m) => (
                <tr key={m.symbol} className={selected === m.symbol ? 'selected' : ''} onClick={() => pick(m.symbol)}>
                  <td><strong>{m.symbol}</strong></td>
                  <td className="feed-num">{m.price ?? '—'}</td>
                  <td><span className={`feed-state s-${m.status}`}>{t(m.status)}</span></td>
                  <td className="feed-num">{m.price ? `${(m.confidenceBps / 100).toFixed(2)}%` : '—'}</td>
                  <td><span className={`feed-dot ${m.fresh ? 'fresh' : 'old'}`} aria-hidden="true" />{ageText(m.ageSec, t)}{!m.fresh && m.price ? <small> · {t('history')}</small> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="feed-note">{t('A green dot means the price was published in the last {minutes} minutes. Plankton publishes a price on-chain when someone is about to trade, so a quiet market can show an older price. Older prices are real on-chain history, not a live quote. Refreshes every {seconds} seconds.', { minutes: Math.round((data?.freshWithinSec ?? 300) / 60), seconds: REFRESH_MS / 1000 })}</p>

        {data && (
          <section className="feed-use" ref={codeRef}>
            <h2>{t('Use it in your own app')}</h2>
            <p>{t('Showing the code for')} <strong>{selected}</strong>. {t('Click another market in the table to change it. Use the single-market endpoint for a compact response, or read the same mark directly from the contract.')}</p>
            <Snippets data={data} symbol={selected} />
            <dl className="feed-facts">
              <div><dt>{t('Chain')}</dt><dd>Robinhood Chain ({data.chainId})</dd></div>
              <div><dt>{t('Oracle contract')}</dt><dd><code>{data.oracle}</code></dd></div>
              <div><dt>{t('Efficient polling')}</dt><dd>{t('Single-market endpoint, two-second server cache, and ETag conditional requests return')} <code>304 Not Modified</code> {t('when the response has not changed.')}</dd></div>
              <div><dt>{t('Price format')}</dt><dd><code>priceE18</code> {t('is the exact on-chain integer with 18 decimals;')} <code>price</code> {t('is the same value in plain USD.')}</dd></div>
              <div><dt>{t('Use with care')}</dt><dd>{t('These are reference prices for building and checking. Check')} <code>fresh</code> {t('and')} <code>ageSec</code> {t('before relying on one.')}</dd></div>
            </dl>
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
