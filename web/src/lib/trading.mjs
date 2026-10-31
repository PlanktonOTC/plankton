// Deterministic frontend demonstration. No signing, APIs or financial execution.
export const DEMO_FEE_BPS = 8;
export const DEMO_SPREAD_BPS = 5;
export const DEMO_COUNTER_NAV = 100000;
export const DEMO_MAINTENANCE_RATE = .05;
export const DEMO_BORROW_RATE_HOURLY = .00004;
const cents = value => Math.round((value + Number.EPSILON) * 100) / 100;
const finite = value => Number.isFinite(Number(value));

export const demoMarkets = [
  { symbol: 'RCAT', name: 'Red Cat Holdings', sector: 'Defense', price: 12.48, change: 3.64, volume: 842360, high: 12.81, low: 11.92, longRoom: 3560, shortRoom: 4100 },
  { symbol: 'NNE', name: 'NANO Nuclear Energy', sector: 'Nuclear', price: 28.16, change: -1.82, volume: 610250, high: 29.12, low: 27.54, longRoom: 2210, shortRoom: 3870 },
  { symbol: 'POET', name: 'POET Technologies', sector: 'Photonics', price: 6.72, change: 5.18, volume: 492180, high: 6.92, low: 6.28, longRoom: 3100, shortRoom: 3320 },
  { symbol: 'QUBT', name: 'Quantum Computing', sector: 'Quantum', price: 10.34, change: 2.41, volume: 740920, high: 10.62, low: 9.83, longRoom: 2880, shortRoom: 3690 },
  { symbol: 'RUN', name: 'Sunrun', sector: 'Energy', price: 8.62, change: -0.93, volume: 580670, high: 8.91, low: 8.42, longRoom: 2500, shortRoom: 3520 },
  { symbol: 'INOD', name: 'Innodata', sector: 'Data', price: 42.76, change: 1.67, volume: 327450, high: 43.4, low: 41.55, longRoom: 1970, shortRoom: 2810 },
  { symbol: 'TE', name: 'T1 Energy', sector: 'Energy', price: 4.28, change: 4.12, volume: 238990, high: 4.41, low: 4.01, longRoom: 3420, shortRoom: 2890 },
  { symbol: 'WYFI', name: 'WhiteFiber', sector: 'Infrastructure', price: 14.84, change: -2.26, volume: 165320, high: 15.44, low: 14.52, longRoom: 1840, shortRoom: 2600 },
].map(market => ({ ...market, tier: 'Small', maxPosition: 1000, maxLeverage: 3, confidenceBps: 9, source: 'Sample data, not live quotes' }));

export function positionPnl(position, mark) {
  return (mark - position.entry) * position.quantity * (position.side === 'long' ? 1 : -1);
}

export function estimatedLiquidation(entry, leverage, side) {
  // Illustrative 5% maintenance model. Production must read the market's contract config.
  return side === 'long' ? entry * (1 - 1 / leverage) / 0.95 : entry * (1 + 1 / leverage) / 1.05;
}

export function sessionSpread(session) {
  return session === 'Halted' ? 300 : ['Weekend', 'Frozen'].includes(session) ? 200 : session === 'Extended' ? 50 : DEMO_SPREAD_BPS;
}

export function positionRisk(position, mark) {
  const notional = position.quantity * mark;
  const pnl = positionPnl(position, mark);
  const equity = position.margin + pnl;
  const maintenance = notional * DEMO_MAINTENANCE_RATE;
  const liquidation = estimatedLiquidation(position.entry, position.quantity * position.entry / position.margin, position.side);
  const distancePercent = (position.side === 'long' ? mark - liquidation : liquidation - mark) / mark * 100;
  return { notional, pnl, equity, maintenance, buffer: equity - maintenance, liquidation, distancePercent,
    healthPercent: equity > 0 ? Math.max(0, Math.min(100, (equity - maintenance) / equity * 100)) : 0,
    effectiveLeverage: equity > 0 ? notional / equity : Infinity,
    borrowPerHour: notional * DEMO_BORROW_RATE_HOURLY,
    status: equity <= maintenance ? 'Below sample maintenance' : distancePercent < 10 ? 'Low buffer' : 'Within sample limits' };
}

export function validateProtection(side, reference, takeProfit, stopLoss) {
  const errors = [];
  const parse = (value, label) => {
    if (value === '' || value === null || value === undefined) return '';
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) errors.push(`${label} must be a positive price.`);
    return n;
  };
  const tp = parse(takeProfit, 'Take profit');
  const sl = parse(stopLoss, 'Stop loss');
  if (tp !== '' && Number.isFinite(tp) && (side === 'long' ? tp <= reference : tp >= reference)) errors.push(`Take profit must be ${side === 'long' ? 'above' : 'below'} the reference mark.`);
  if (sl !== '' && Number.isFinite(sl) && (side === 'long' ? sl >= reference : sl <= reference)) errors.push(`Stop loss must be ${side === 'long' ? 'below' : 'above'} the reference mark.`);
  return { valid: errors.length === 0, errors, takeProfit: tp, stopLoss: sl };
}

export function accountTotals(state, markets = demoMarkets) {
  const margin = state.positions.reduce((sum, p) => sum + p.margin, 0);
  const pnl = state.positions.reduce((sum, p) => sum + positionPnl(p, markets.find(m => m.symbol === p.symbol)?.price ?? p.entry), 0);
  const reserved = state.orders.reduce((sum, o) => sum + o.margin, 0);
  return { free: state.cash, margin, pnl, reserved, equity: state.cash + margin + pnl + reserved };
}

export function buildQuote(state, market, request) {
  const margin = Number(request.margin);
  const leverage = Number(request.leverage);
  const session = request.session || 'Open';
  const type = request.type || 'Market';
  const side = request.side;
  const errors = [];
  const existing = state.positions.find(p => p.symbol === market.symbol);
  const reserved = state.orders.filter(o => o.symbol === market.symbol).reduce((sum, o) => sum + o.notional, 0);
  if (side !== 'long' && side !== 'short') errors.push('Choose Long or Short.');
  if (!finite(margin) || margin <= 0) errors.push('Enter a margin greater than 0 USDG.');
  if (![2, 3].includes(leverage)) errors.push('Choose 2x or 3x leverage.');
  if (!['Market', 'Limit', 'Stop'].includes(type)) errors.push('Choose a supported order type.');
  if (!['Open', 'Extended', 'Weekend', 'Frozen', 'Halted', 'Close-only'].includes(session)) errors.push('Choose a supported market-state scenario.');
  if (['Frozen', 'Halted', 'Close-only'].includes(session)) errors.push(`${session}: new positions are unavailable. Existing positions can still close.`);
  if (['Weekend', 'Extended'].includes(session) && leverage > 2) errors.push(`The sample ${session.toLowerCase()} profile is limited to 2x.`);
  if (existing && existing.side !== side) errors.push('Close the existing position before opening the opposite side.');
  const notional = margin * leverage;
  const cap = session === 'Weekend' ? 250 : session === 'Extended' ? 500 : market.maxPosition;
  const used = existing ? existing.quantity * market.price : 0;
  if (notional + used + reserved > cap + 0.00001) errors.push(`This account has ${Math.max(0, cap - used - reserved).toFixed(2)} USDG of position capacity available.`);
  if (notional > (side === 'long' ? market.longRoom : market.shortRoom)) errors.push('Notional exceeds available market capacity.');
  const fee = cents(notional * DEMO_FEE_BPS / 10000);
  if (margin + (type === 'Market' ? fee : 0) > state.cash) errors.push('Insufficient available demo collateral.');
  const trigger = Number(request.trigger);
  if (type !== 'Market' && (!finite(trigger) || trigger <= 0)) errors.push('Enter a valid order price.');
  const spreadBps = session === 'Weekend' ? 200 : session === 'Extended' ? 50 : DEMO_SPREAD_BPS;
  const price = type === 'Market' ? market.price * (1 + (side === 'long' ? 1 : -1) * spreadBps / 10000) : trigger;
  const protection = validateProtection(side, price, request.takeProfit, request.stopLoss);
  errors.push(...protection.errors);
  return { valid: errors.length === 0, errors, symbol: market.symbol, side, type, session, margin, leverage, notional, fee, price, quantity: notional / price, spreadBps, liquidation: estimatedLiquidation(price, leverage, side), takeProfit: protection.takeProfit, stopLoss: protection.stopLoss };
}

export function submitDemoOrder(state, market, request) {
  const quote = buildQuote(state, market, request);
  if (!quote.valid) return { state, error: quote.errors[0] };
  const id = state.nextId;
  const event = { id, symbol: market.symbol, side: quote.side, type: quote.type === 'Market' ? 'Opened' : `${quote.type} placed`, notional: quote.notional, price: quote.price, pnl: null };
  if (quote.type !== 'Market') {
    return { state: { ...state, nextId: id + 1, cash: cents(state.cash - quote.margin), orders: [...state.orders, { ...quote, id }], history: [event, ...state.history] }, quote };
  }
  const existing = state.positions.find(p => p.symbol === market.symbol);
  let positions;
  if (existing) {
    const quantity = existing.quantity + quote.quantity;
    const margin = existing.margin + quote.margin;
    const entry = (existing.quantity * existing.entry + quote.notional) / quantity;
    positions = state.positions.map(p => p.id === existing.id ? { ...p, quantity, margin, entry, leverage: quantity * entry / margin, takeProfit: quote.takeProfit || p.takeProfit, stopLoss: quote.stopLoss || p.stopLoss } : p);
  } else {
    positions = [...state.positions, { id, symbol: market.symbol, side: quote.side, quantity: quote.quantity, margin: quote.margin, entry: quote.price, leverage: quote.leverage, takeProfit: quote.takeProfit, stopLoss: quote.stopLoss }];
  }
  return { state: { ...state, nextId: id + 1, cash: cents(state.cash - quote.margin - quote.fee), positions, history: [event, ...state.history] }, quote };
}

export function closeDemoPosition(state, positionId, percent, mark, fallback = false, spreadBps = fallback ? 200 : DEMO_SPREAD_BPS) {
  const position = state.positions.find(p => p.id === positionId);
  if (!position || !finite(percent) || percent <= 0 || percent > 100 || !finite(mark) || mark <= 0 || !finite(spreadBps) || spreadBps < 0 || spreadBps >= 10000) return { state, error: 'Choose a valid position and close percentage.' };
  const fraction = Number(percent) / 100;
  const price = mark * (1 + (position.side === 'long' ? -1 : 1) * Number(spreadBps) / 10000);
  const quantity = position.quantity * fraction;
  const pnl = (price - position.entry) * quantity * (position.side === 'long' ? 1 : -1);
  const fee = cents(quantity * price * DEMO_FEE_BPS / 10000);
  const released = Math.max(0, position.margin * fraction + pnl - fee);
  const positions = Number(percent) === 100 ? state.positions.filter(p => p.id !== positionId) : state.positions.map(p => p.id === positionId ? { ...p, quantity: p.quantity - quantity, margin: p.margin * (1 - fraction) } : p);
  return { state: { ...state, nextId: state.nextId + 1, cash: cents(state.cash + released), positions, history: [{ id: state.nextId, symbol: position.symbol, side: position.side, type: fallback ? 'Close at mark' : Number(percent) === 100 ? 'Closed' : `Trimmed ${percent}%`, notional: quantity * price, price, pnl: pnl - fee }, ...state.history] }, pnl, fee, released };
}

export function cancelDemoOrder(state, orderId) {
  const order = state.orders.find(o => o.id === orderId);
  if (!order) return state;
  return { ...state, cash: cents(state.cash + order.margin), orders: state.orders.filter(o => o.id !== orderId), nextId: state.nextId + 1, history: [{ id: state.nextId, symbol: order.symbol, side: order.side, type: 'Cancelled', notional: order.notional, price: order.price, pnl: null }, ...state.history] };
}

export function addDemoMargin(state, positionId, amount) {
  const position = state.positions.find(p => p.id === positionId);
  const value = Number(amount);
  if (!position || !finite(value) || value <= 0 || value > state.cash) return { state, error: 'Enter a positive margin amount within your available demo collateral.' };
  const margin = cents(position.margin + value);
  return { state: { ...state, cash: cents(state.cash - value), positions: state.positions.map(p => p.id === positionId ? { ...p, margin, leverage: p.quantity * p.entry / margin } : p), nextId: state.nextId + 1, history: [{ id: state.nextId, symbol: position.symbol, side: position.side, type: 'Margin added', notional: value, price: position.entry, pnl: null }, ...state.history] } };
}

export function editDemoOrder(state, orderId, market, changes) {
  const order = state.orders.find(item => item.id === orderId);
  if (!order || order.symbol !== market.symbol) return { state, error: 'This pending order is no longer available.' };
  const available = { ...state, cash: cents(state.cash + order.margin), orders: state.orders.filter(item => item.id !== orderId) };
  const quote = buildQuote(available, market, { ...order, trigger: order.price, ...changes, type: order.type, side: order.side });
  if (!quote.valid) return { state, error: quote.errors[0] };
  return { state: { ...state, cash: cents(available.cash - quote.margin), nextId: state.nextId + 1,
    orders: state.orders.map(item => item.id === orderId ? { ...quote, id: orderId } : item),
    history: [{ id: state.nextId, symbol: order.symbol, side: order.side, type: 'Order amended', notional: quote.notional, price: quote.price, pnl: null }, ...state.history] }, quote };
}

export function setDemoProtection(state, positionId, mark, takeProfit, stopLoss) {
  const position = state.positions.find(item => item.id === positionId);
  if (!position || !finite(mark) || Number(mark) <= 0) return { state, error: 'This position or reference mark is unavailable.' };
  const protection = validateProtection(position.side, Number(mark), takeProfit, stopLoss);
  if (!protection.valid) return { state, error: protection.errors[0] };
  return { state: { ...state, nextId: state.nextId + 1,
    positions: state.positions.map(item => item.id === positionId ? { ...item, takeProfit: protection.takeProfit, stopLoss: protection.stopLoss } : item),
    history: [{ id: state.nextId, symbol: position.symbol, side: position.side, type: protection.takeProfit || protection.stopLoss ? 'Protection updated' : 'Protection removed', notional: position.quantity * mark, price: Number(mark), pnl: null }, ...state.history] } };
}

/** Explicit, deterministic scenario step. Never called by a timer or price feed.
 * Protection reduces existing positions first; pending entries are revalidated
 * against the new mark, session, capacity, collateral and current protection.
 * No liquidation, borrow accrual, partial fill or keeper activity is simulated.
 */
export function runDemoScenario(state, market, nextMark, session = 'Open') {
  const mark = Number(nextMark);
  if (!Number.isFinite(mark) || mark <= 0 || !['Open', 'Extended', 'Weekend', 'Frozen', 'Halted', 'Close-only'].includes(session)) return { state, error: 'Enter a positive scenario mark and a valid market state.', reports: [] };
  let next = state;
  const reports = [];
  const scenarioMarket = { ...market, price: mark };
  const canOpen = !['Frozen', 'Halted', 'Close-only'].includes(session);
  const canTriggerExit = !['Frozen', 'Halted'].includes(session);
  for (const position of state.positions.filter(item => item.symbol === market.symbol)) {
    const stop = position.stopLoss && (position.side === 'long' ? mark <= Number(position.stopLoss) : mark >= Number(position.stopLoss));
    const take = position.takeProfit && (position.side === 'long' ? mark >= Number(position.takeProfit) : mark <= Number(position.takeProfit));
    if (!stop && !take) continue;
    const label = stop ? 'Stop loss' : 'Take profit';
    if (!canTriggerExit) { reports.push({ kind: 'held', text: `${label} held: ${session} requires an explicit close path.` }); continue; }
    const closed = closeDemoPosition(next, position.id, 100, mark, false, sessionSpread(session));
    if (closed.error) { reports.push({ kind: 'blocked', text: closed.error }); continue; }
    next = { ...closed.state, history: closed.state.history.map((event, index) => index === 0 ? { ...event, type: `Demo ${label.toLowerCase()}` } : event) };
    reports.push({ kind: 'exit', text: `${label}: close remaining ${market.symbol} ${position.side} at ${next.history[0].price.toFixed(4)}; fee ${closed.fee.toFixed(2)} USDG.`, price: next.history[0].price });
  }
  for (const order of state.orders.filter(item => item.symbol === market.symbol)) {
    const triggers = order.type === 'Limit'
      ? (order.side === 'long' ? mark <= order.price : mark >= order.price)
      : (order.side === 'long' ? mark >= order.price : mark <= order.price);
    if (!triggers) { reports.push({ kind: 'waiting', text: `${order.type} #${order.id}: trigger not reached.` }); continue; }
    if (!canOpen) { reports.push({ kind: 'held', text: `${order.type} #${order.id}: new opens blocked in ${session}.` }); continue; }
    const executable = mark * (1 + (order.side === 'long' ? 1 : -1) * sessionSpread(session) / 10000);
    if (order.type === 'Limit' && (order.side === 'long' ? executable > order.price : executable < order.price)) {
      reports.push({ kind: 'waiting', text: `Limit #${order.id}: spread-adjusted quote exceeds the limit.` }); continue;
    }
    const released = { ...next, cash: cents(next.cash + order.margin), orders: next.orders.filter(item => item.id !== order.id) };
    const filled = submitDemoOrder(released, scenarioMarket, { ...order, type: 'Market', session });
    if (filled.error) { reports.push({ kind: 'blocked', text: `${order.type} #${order.id}: ${filled.error}` }); continue; }
    next = { ...filled.state, history: filled.state.history.map((event, index) => index === 0 ? { ...event, type: `Demo ${order.type.toLowerCase()} filled`, orderId: order.id } : event) };
    reports.push({ kind: 'entry', text: `${order.type} #${order.id}: ${order.side} ${order.notional.toFixed(2)} USDG at ${filled.quote.price.toFixed(4)}; fee ${filled.quote.fee.toFixed(2)} USDG.`, price: filled.quote.price });
  }
  const breached = next.positions.filter(item => item.symbol === market.symbol && positionRisk(item, mark).buffer <= 0);
  if (breached.length) reports.push({ kind: 'risk', text: 'A position is below the illustrative maintenance threshold. Liquidation is not simulated; use an explicit close.' });
  if (!reports.length) reports.push({ kind: 'mark', text: 'Update the local scenario mark. No order or protection trigger is attached.' });
  return { state: next, market: scenarioMarket, mark, reports };
}

export function createDemoAccount() {
  return {
    cash: 9799.52,
    nextId: 2,
    positions: [{ id: 1, symbol: 'RCAT', side: 'long', quantity: 600 / 12.12, margin: 200, entry: 12.12, leverage: 3, takeProfit: '', stopLoss: '' }],
    orders: [],
    history: [{ id: 1, symbol: 'RCAT', side: 'long', type: 'Sample position', notional: 600, price: 12.12, pnl: null }],
  };
}

export function makeCandles(symbol, timeframe = '1H', count = 62) {
  const market = demoMarkets.find(m => m.symbol === symbol) || demoMarkets[0];
  const seed = [...symbol + timeframe].reduce((a, c) => a + c.charCodeAt(0), 0);
  let value = market.price * 0.936;
  const candles = Array.from({ length: count }, (_, i) => {
    const open = value;
    const drift = Math.sin(i * 1.73 + seed) * market.price * 0.007 + Math.cos(i * 0.42 + seed) * market.price * 0.003 + market.price * 0.00105;
    const close = open + drift;
    value = close;
    return { open, close, high: Math.max(open, close) + market.price * (0.002 + (Math.sin(i + seed) + 1) * 0.002), low: Math.min(open, close) - market.price * (0.002 + (Math.cos(i + seed) + 1) * 0.002), volume: 15 + Math.abs(Math.sin(i * 2.1 + seed)) * 68 };
  });
  const scale = market.price / candles.at(-1).close;
  const interval = { '15M': 900000, '1H': 3600000, '4H': 14400000, '1D': 86400000 }[timeframe] || 3600000;
  const end = Date.UTC(2026, 9, 27, 20);
  return candles.map((c, i) => ({ ...c, time: end - (count - 1 - i) * interval, open: c.open * scale, close: c.close * scale, high: c.high * scale, low: c.low * scale }));
}
