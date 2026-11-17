import React from 'react';
import { useCatalysts, useFilings } from '../live/queries.js';
import { marketIntel } from '../live/market-intel.js';
import { useI18n } from '../i18n';

const dateLabel = (value) => value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;

export default function MarketIntel({ symbol, active }) {
  const { t: tr } = useI18n();
  const filingsQuery = useFilings(active);
  const catalystsQuery = useCatalysts(active);
  const intel = marketIntel(symbol, filingsQuery.data?.filings, catalystsQuery.data);

  return (
    <section className="term-market-intel" aria-label={tr('News and filing context for {symbol}', { symbol })}>
      <div className="term-market-intel-heading">
        <div><span className="term-overline">{tr('COMPANY UPDATES')}</span><h2>{tr('News and sentiment')}</h2></div>
        <span className={`term-market-sentiment ${intel.riskCount ? 'is-risk' : ''}`}>{tr(intel.sentiment)}</span>
      </div>
      <p className="term-market-intel-note">{tr('Sentiment is a summary of tagged SEC filing risks, not social media or a price prediction.')}</p>
      <div className="term-market-intel-items">
        {intel.earnings && <article><span>{tr('Next earnings')} · {intel.earnings.verified ? tr('Confirmed') : tr('Estimated')}</span><strong>{dateLabel(intel.earnings.date)}{intel.earnings.timing ? ` · ${intel.earnings.timing === 'am' ? tr('Before open') : tr('After close')}` : ''}</strong></article>}
        {intel.actions.map((action) => <article key={action.id}><span>{tr('Corporate action')} · {tr(action.type)}</span><strong>{action.processDate ? dateLabel(action.processDate) : tr('Date not provided')}</strong></article>)}
        {intel.filings.map((filing) => <article key={filing.accession}>
          <span>{tr('SEC filing')} · {filing.form} · {dateLabel(filing.filingDate)}</span>
          <strong>{filing.description || filing.tags?.map((tag) => tr(tag)).join(', ') || tr('Company filing')}</strong>
          <a href={filing.url} target="_blank" rel="noreferrer">{tr('Read filing')} ↗</a>
        </article>)}
        {!intel.earnings && !intel.actions.length && !intel.filings.length && <div className="term-market-intel-empty">{tr('No company updates are available for this market right now.')}</div>}
      </div>
      <small>{tr('Sources: SEC EDGAR and public company earnings and corporate-action data. Dates can change.')}</small>
    </section>
  );
}
