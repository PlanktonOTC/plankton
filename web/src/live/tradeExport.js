import { apiGet, query } from './api.js';
import { explorerTx } from './wagmi.js';

const PAGE_SIZE = 500;
const PATHS = ['market', 'keeper order', 'close at mark', 'liquidation'];

export async function fetchTradeExport(address, year) {
  const all = [];
  let cursor = null;
  do {
    const page = await apiGet(`/v1/accounts/${address}/trades${query({ year, limit: PAGE_SIZE, ...cursor })}`);
    all.push(...page.trades);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

function decimal(raw, decimals, places = decimals) {
  const value = BigInt(raw);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const retained = absolute / (10n ** BigInt(decimals - places));
  const unit = 10n ** BigInt(places);
  const whole = retained / unit;
  const fraction = (retained % unit).toString().padStart(places, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tradeRows(trades) {
  return trades.map((trade) => {
    const size = BigInt(trade.sizeDeltaE18);
    const price = BigInt(trade.priceE18);
    const realized = BigInt(trade.realizedPnlUsdg);
    const fee = BigInt(trade.feeUsdg);
    return [
      new Date(trade.at).toISOString(),
      new Date(trade.at).getUTCFullYear(),
      trade.symbol ?? trade.marketId,
      size >= 0n ? 'buy' : 'sell',
      decimal(size, 18, 8),
      decimal(price, 18, 8),
      decimal((size < 0n ? -size : size) * price, 36, 6),
      decimal(fee, 6, 6),
      decimal(realized, 6, 6),
      decimal(realized - fee, 6, 6),
      PATHS[trade.path] ?? `path ${trade.path}`,
      trade.txHash,
      trade.block,
      trade.logIndex,
      explorerTx(trade.txHash),
    ];
  });
}

const DETAIL_HEADER = ['Timestamp (UTC)', 'Tax year (UTC)', 'Market', 'Side', 'Position size (underlying units)', 'Price (USD)', 'Notional (USDG)', 'Fee (USDG)', 'Realized P&L (USDG)', 'Event P&L less fee (USDG)', 'Execution path', 'Transaction hash', 'Block', 'Log index', 'Explorer'];

function csvText(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

function downloadCsv(filename, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function shortWallet(address) {
  return `${address.slice(0, 6)}-${address.slice(-4)}`;
}

export function downloadTradeHistory(address, trades) {
  downloadCsv(`plankton-trades-${shortWallet(address)}.csv`, tradeHistoryCsv(trades));
}

export function tradeHistoryCsv(trades) {
  return csvText([DETAIL_HEADER, ...tradeRows(trades)]);
}

export function taxReportCsv(address, year, trades) {
  const fees = trades.reduce((sum, trade) => sum + BigInt(trade.feeUsdg), 0n);
  const realized = trades.reduce((sum, trade) => sum + BigInt(trade.realizedPnlUsdg), 0n);
  const net = realized - fees;
  const summary = [
    ['Plankton trade activity summary'],
    ['Wallet', address],
    ['Tax year (UTC)', year],
    ['Settlement currency', 'USDG'],
    ['Indexed trade events', trades.length],
    ['Realized P&L before fees (USDG)', decimal(realized, 6, 6)],
    ['Recorded trade fees (USDG)', decimal(fees, 6, 6)],
    ['Realized P&L less all recorded trade fees (USDG)', decimal(net, 6, 6)],
    ['Coverage', 'Indexed TradeExecuted fills and recorded fees only. Fees include open fills; borrow, deposits, withdrawals, liquidity activity, and jurisdiction-specific tax treatment are not included.'],
    [],
    DETAIL_HEADER,
  ];
  return csvText([...summary, ...tradeRows(trades)]);
}

export function downloadTaxReport(address, year, trades) {
  downloadCsv(`plankton-tax-summary-${year}-${shortWallet(address)}.csv`, taxReportCsv(address, year, trades));
}
