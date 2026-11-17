const PENDING_ACTION_STATES = new Set(['pending', 'scheduled', 'announced', 'approved', 'processing', 'in_progress']);

export function marketAlerts(symbol, haltBoard = null, catalysts = null) {
  const halts = (haltBoard?.halts ?? []).filter((item) => item.symbol === symbol && item.listed && (item.state === 'halted' || item.state === 'resuming'));
  const splits = (catalysts?.corporateActions ?? []).filter((item) => item.symbol === symbol
    && /split/i.test(item.type ?? '')
    && PENDING_ACTION_STATES.has(String(item.status ?? '').toLowerCase()));
  return [
    ...halts.map((item) => ({ id: `halt:${item.symbol}:${item.startedAt}:${item.reasonCode}`, kind: 'halt', data: item })),
    ...splits.map((item) => ({ id: `split:${item.id}`, kind: 'split', data: item })),
  ];
}
