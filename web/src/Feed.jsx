import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Header, Footer } from './App';
import './feed.css';

// The public Plankton price feed page. It reads /api/v1/feed, which reads MarkOracle on Robinhood Chain.
const REFRESH_MS = 5000;

export function ageText(sec) {
  if (sec === null || sec === undefined) return 'never';
  if (sec < 90) return `${sec}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} days ago`;
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
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      t.remove();
    }
    setDone(true); setTimeout(() => setDone(false), 1500);
  };
  return <button type="button" className="feed-copy" onClick={copy}>{done ? 'Copied ✓' : label}</button>;
}

function Snippets({ data, symbol }) {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const row = data?.markets.find((m) => m.symbol === symbol) ?? data?.markets[0];
  const snippets = useMemo(() => {
    if (!data || !row) return [];
    const endpoint = `${origin}/api/v1/feed/${row.symbol}`;
    return [
      ['curl', `curl -i '${endpoint}'\n\n# Revalidate with the ETag from the previous response:\ncurl -i -H 'If-None-Match: "<etag>"' '${endpoint}'`],
      ['JavaScript', `const url = '${endpoint}';\nlet etag;\n\nasync function read${row.symbol}() {\n  const res = await fetch(url, { headers: etag ? { 'If-None-Match': etag } : {} });\n  if (res.status === 304) return console.log('${row.symbol} unchanged');\n  if (!res.ok) throw new Error(\`Feed HTTP \${res.status}\`);\n  etag = res.headers.get('ETag');\n  const { market } = await res.json();\n  console.log(market.price, market.ageSec, market.fresh, market.status);\n}\n\nawait read${row.symbol}();`],
      ['Solidity (on-chain)', `// Chain ${data.chainId}. Oracle: ${data.oracle}\nIMarkOracle.Mark memory m = IMarkOracle(${data.oracle}).markOf(\n    ${row.marketId}\n); // ${row.symbol}\n// m.priceE18 (18 decimals), m.updatedAt, m.status, m.confidenceBps`],
    ];
  }, [data, row, origin]);
  const [tab, setTab] = useState(0);
  if (!snippets.length) return null;
  const [, code] = snippets[tab];
  return (
    <div className="feed-code">
      <div className="feed-code-tabs" role="tablist" aria-label="Code example">
        {snippets.map(([name], i) => <button key={name} role="tab" aria-selected={tab === i} className={tab === i ? 'active' : ''} onClick={() => setTab(i)}>{name}</button>)}
        <CopyButton text={code} />
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export default function Feed() {
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
        <span className="eyebrow">PLANKTON PRICE FEED</span>
        <h1>On-chain prices<br />for small caps.</h1>
        <p className="feed-lead">The latest price each Plankton market holds on Robinhood Chain, read straight from the oracle contract. Free to use, no key needed, open to any website or script. Single-market lookups read only that market, with ETags for lightweight revalidation.</p>

        <div className="feed-endpoint">
          <code>GET {endpoint}</code>
          <CopyButton text={endpoint} label="Copy URL" />
        </div>

        {error && <p className="feed-error" role="alert">{data ? `Showing the last good data. ${error}.` : `${error}. Try again in a moment.`}</p>}

        <div className="feed-table-wrap">
          <table className="feed-table">
            <thead><tr><th>Market</th><th>Price (USD)</th><th>State</th><th title="How far apart the price sources were. Smaller is better.">Uncertainty</th><th>Last on-chain update</th></tr></thead>
            <tbody>
              {loading && !data && <tr><td colSpan="5" className="feed-empty">Loading prices…</td></tr>}
              {markets.map((m) => (
                <tr key={m.symbol} className={selected === m.symbol ? 'selected' : ''} onClick={() => pick(m.symbol)}>
                  <td><strong>{m.symbol}</strong></td>
                  <td className="feed-num">{m.price ?? '—'}</td>
                  <td><span className={`feed-state s-${m.status}`}>{m.status}</span></td>
                  <td className="feed-num">{m.price ? `${(m.confidenceBps / 100).toFixed(2)}%` : '—'}</td>
                  <td><span className={`feed-dot ${m.fresh ? 'fresh' : 'old'}`} aria-hidden="true" />{ageText(m.ageSec)}{!m.fresh && m.price ? <small> · history</small> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="feed-note">A green dot means the price was published in the last {Math.round((data?.freshWithinSec ?? 300) / 60)} minutes. Plankton publishes a price on-chain when someone is about to trade, so a quiet market can show an older price. Older prices are real on-chain history, not a live quote. Refreshes every {REFRESH_MS / 1000} seconds.</p>

        {data && (
          <section className="feed-use" ref={codeRef}>
            <h2>Use it in your own app</h2>
            <p>Showing the code for <strong>{selected}</strong>. Click another market in the table to change it. Use the single-market endpoint for a compact response, or read the same mark directly from the contract.</p>
            <Snippets data={data} symbol={selected} />
            <dl className="feed-facts">
              <div><dt>Chain</dt><dd>Robinhood Chain ({data.chainId})</dd></div>
              <div><dt>Oracle contract</dt><dd><code>{data.oracle}</code></dd></div>
              <div><dt>Efficient polling</dt><dd>Single-market endpoint, two-second server cache, and ETag conditional requests return <code>304 Not Modified</code> when the response has not changed.</dd></div>
              <div><dt>Price format</dt><dd><code>priceE18</code> is the exact on-chain integer with 18 decimals; <code>price</code> is the same value in plain USD.</dd></div>
              <div><dt>Use with care</dt><dd>These are reference prices for building and checking. Check <code>fresh</code> and <code>ageSec</code> before relying on one.</dd></div>
            </dl>
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
