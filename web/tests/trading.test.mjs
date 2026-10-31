import test from 'node:test';
import assert from 'node:assert/strict';
import { demoMarkets, createDemoAccount, buildQuote, submitDemoOrder, closeDemoPosition, cancelDemoOrder, accountTotals, addDemoMargin, positionRisk, editDemoOrder, setDemoProtection, runDemoScenario } from '../src/lib/trading.mjs';
const market = demoMarkets[1];
const request = { margin: 100, leverage: 3, side: 'long', type: 'Market', session: 'Open' };

test('market order deducts margin plus fee and creates a position', () => {
  const before = createDemoAccount();
  const result = submitDemoOrder(before, market, request);
  assert.equal(result.state.cash, 9699.28);
  assert.equal(result.state.positions.length, 2);
  assert.equal(result.quote.fee, 0.24);
  assert.equal(before.positions.length, 1);
});

test('rejects non-finite, negative, oversize and insufficient-collateral input', () => {
  const state = createDemoAccount();
  for (const margin of [NaN, Infinity, -1, 0, 1000]) assert.equal(buildQuote(state, market, { ...request, margin }).valid, false);
  assert.equal(buildQuote({ ...state, cash: 20 }, market, request).valid, false);
});

test('does not bypass per-account market cap through repeated orders', () => {
  let state = submitDemoOrder(createDemoAccount(), market, { ...request, margin: 200 }).state;
  const result = submitDemoOrder(state, market, { ...request, margin: 200 });
  assert.ok(result.error);
  assert.equal(result.state, state);
});

test('halted opens are blocked but risk reduction remains available', () => {
  const state = createDemoAccount();
  assert.equal(buildQuote(state, market, { ...request, session: 'Halted' }).valid, false);
  const closed = closeDemoPosition(state, 1, 100, demoMarkets[0].price, true);
  assert.equal(closed.state.positions.length, 0);
  assert.ok(closed.state.cash > state.cash);
});

test('weekend enforces both leverage and ticket allowance', () => {
  const state = createDemoAccount();
  assert.equal(buildQuote(state, market, { ...request, session: 'Weekend' }).valid, false);
  assert.equal(buildQuote(state, market, { ...request, margin: 100, leverage: 2, session: 'Weekend' }).valid, true);
  assert.equal(buildQuote(state, market, { ...request, margin: 150, leverage: 2, session: 'Weekend' }).valid, false);
});

test('extended session reduces leverage/capacity and halted close uses its wider spread', () => {
  const state = createDemoAccount();
  assert.equal(buildQuote(state, market, { ...request, session: 'Extended' }).valid, false);
  const extended = buildQuote(state, market, { ...request, leverage: 2, session: 'Extended' });
  assert.equal(extended.valid, true);
  assert.equal(extended.spreadBps, 50);
  assert.equal(buildQuote(state, market, { ...request, leverage: 2, margin: 300, session: 'Extended' }).valid, false);
  const frozen = closeDemoPosition(state, 1, 100, demoMarkets[0].price, true, 200);
  const halted = closeDemoPosition(state, 1, 100, demoMarkets[0].price, true, 300);
  assert.ok(halted.released < frozen.released);
});

test('partial close releases proportional margin and retains remainder', () => {
  const state = createDemoAccount();
  const result = closeDemoPosition(state, 1, 25, demoMarkets[0].price);
  assert.equal(result.state.positions[0].margin, 150);
  assert.equal(result.state.positions[0].quantity, state.positions[0].quantity * .75);
  assert.ok(result.state.cash > state.cash + 50);
  assert.equal(result.state.history[0].type, 'Trimmed 25%');
});

test('pending orders reserve margin, cancellation returns it exactly once', () => {
  const state = createDemoAccount();
  const queued = submitDemoOrder(state, market, { ...request, type: 'Limit', trigger: 27 });
  assert.equal(queued.state.cash, state.cash - 100);
  assert.equal(accountTotals(queued.state).reserved, 100);
  const cancelled = cancelDemoOrder(queued.state, queued.state.orders[0].id);
  assert.equal(cancelled.cash, state.cash);
  assert.equal(cancelled.orders.length, 0);
  assert.equal(cancelDemoOrder(cancelled, 999), cancelled);
});

test('rejects invalid closes and opposite positions without changing state', () => {
  const state = createDemoAccount();
  for (const percent of [0, -1, 101, Infinity]) assert.equal(closeDemoPosition(state, 1, percent, 12).state, state);
  assert.equal(submitDemoOrder(state, demoMarkets[0], { ...request, side: 'short' }).state, state);
});

test('adding margin conserves equity without increasing the position size', () => {
  const state = createDemoAccount();
  const result = addDemoMargin(state, 1, 100);
  assert.equal(result.state.cash, state.cash - 100);
  assert.equal(result.state.positions[0].margin, 300);
  assert.equal(result.state.positions[0].quantity, state.positions[0].quantity);
  assert.equal(accountTotals(result.state).equity, accountTotals(state).equity);
  assert.equal(addDemoMargin(state, 1, Infinity).state, state);
});

test('amending an order releases old reservation before validating the new amount', () => {
  const initial = createDemoAccount();
  const queued = submitDemoOrder(initial, market, { ...request, type: 'Limit', trigger: 27 }).state;
  const result = editDemoOrder(queued, queued.orders[0].id, market, { margin: 150, trigger: 26.5 });
  assert.equal(result.state.cash, initial.cash - 150);
  assert.equal(result.state.orders.length, 1);
  assert.equal(result.state.orders[0].id, queued.orders[0].id);
  assert.equal(result.state.orders[0].price, 26.5);
  assert.equal(editDemoOrder(queued, queued.orders[0].id, market, { margin: 10000 }).state, queued);
});

test('position protection uses current mark and supports a profit-locking stop', () => {
  const initial = createDemoAccount();
  const protectedState = setDemoProtection(initial, 1, 12.48, 13.2, 12.3);
  assert.equal(protectedState.state.positions[0].stopLoss, 12.3);
  assert.equal(setDemoProtection(initial, 1, 12.48, 12, '').state, initial);
  assert.equal(setDemoProtection(initial, 1, 12.48, '', 12.8).state, initial);
  const cleared = setDemoProtection(protectedState.state, 1, 12.48, '', '');
  assert.equal(cleared.state.positions[0].stopLoss, '');
  assert.equal(cleared.state.cash, initial.cash);
});

test('explicit scenario respects a limit price including spread and reserves margin until fill', () => {
  const initial = createDemoAccount();
  const queued = submitDemoOrder(initial, market, { ...request, type: 'Limit', trigger: 27 }).state;
  const waiting = runDemoScenario(queued, market, 27);
  assert.equal(waiting.state, queued);
  assert.match(waiting.reports[0].text, /spread-adjusted/);
  const filled = runDemoScenario(queued, market, 26.5);
  assert.equal(filled.state.orders.length, 0);
  assert.equal(filled.state.positions.length, 2);
  assert.equal(filled.state.cash, initial.cash - 100 - .24);
  assert.ok(filled.state.positions[1].entry <= 27);
  assert.equal(queued.orders.length, 1);
});

test('explicit stop scenario can gap past trigger and cannot fill twice', () => {
  const queued = submitDemoOrder(createDemoAccount(), market, { ...request, type: 'Stop', trigger: 29 }).state;
  const filled = runDemoScenario(queued, market, 30);
  assert.ok(filled.state.positions.at(-1).entry > 29);
  const again = runDemoScenario(filled.state, market, 31);
  assert.equal(again.state.positions.length, filled.state.positions.length);
  assert.equal(again.state.cash, filled.state.cash);
});

test('scenario rechecks market state, leverage and cap instead of assuming pending orders can fill', () => {
  const queued = submitDemoOrder(createDemoAccount(), market, { ...request, type: 'Stop', trigger: 29 }).state;
  for (const session of ['Halted', 'Frozen', 'Close-only', 'Weekend', 'Extended']) {
    const result = runDemoScenario(queued, market, 30, session);
    assert.equal(result.state, queued);
    assert.equal(result.state.orders.length, 1);
    assert.ok(result.reports.some(item => ['held', 'blocked'].includes(item.kind)));
  }
});

test('protection closes only the remaining size after a trim and uses actual scenario fill', () => {
  const protectedState = setDemoProtection(createDemoAccount(), 1, 12.48, 13, 11).state;
  const trimmed = closeDemoPosition(protectedState, 1, 50, 12.48).state;
  const result = runDemoScenario(trimmed, demoMarkets[0], 10.5);
  assert.equal(result.state.positions.length, 0);
  assert.equal(result.state.history[0].type, 'Demo stop loss');
  assert.ok(result.state.history[0].price < 11);
  assert.equal(result.reports[0].kind, 'exit');
  assert.equal(runDemoScenario(result.state, demoMarkets[0], 10).state.cash, result.state.cash);
});

test('halted scenario holds protection for explicit close and never auto-liquidates', () => {
  const state = setDemoProtection(createDemoAccount(), 1, 12.48, 13, 11).state;
  const result = runDemoScenario(state, demoMarkets[0], 5, 'Halted');
  assert.equal(result.state, state);
  assert.ok(result.reports.some(item => item.kind === 'held'));
  assert.ok(result.reports.some(item => item.kind === 'risk'));
  assert.equal(positionRisk(state.positions[0], 5).healthPercent, 0);
});

test('risk buffer increases after adding isolated margin, without changing exposure', () => {
  const state = createDemoAccount();
  const before = positionRisk(state.positions[0], 12.48);
  const added = addDemoMargin(state, 1, 100).state;
  const after = positionRisk(added.positions[0], 12.48);
  assert.equal(after.notional, before.notional);
  assert.ok(after.buffer > before.buffer);
  assert.ok(after.liquidation < before.liquidation);
  assert.ok(after.effectiveLeverage < before.effectiveLeverage);
});
