const RISK_TAGS = new Set(['offering', 'shelf', 'dilution', 'late_filing', 'delisting', 'listing_notice', 'financing']);

/** Combine public filings and known catalysts for one market. This is filing context, not a predictive sentiment score. */
export function marketIntel(symbol, filings = [], catalysts = null) {
  const marketFilings = (filings ?? []).filter((item) => item.symbol === symbol).slice(0, 5);
  const earnings = (catalysts?.earnings ?? []).find((item) => item.symbol === symbol)?.next ?? null;
  const actions = (catalysts?.corporateActions ?? []).filter((item) => item.symbol === symbol);
  const riskCount = marketFilings.filter((item) => item.tags?.some((tag) => RISK_TAGS.has(tag))).length;
  const sentiment = riskCount > 0 ? 'Risk flagged' : marketFilings.length ? 'No flagged filing risk' : 'Not enough filing data';
  return { filings: marketFilings, earnings, actions, sentiment, riskCount };
}
