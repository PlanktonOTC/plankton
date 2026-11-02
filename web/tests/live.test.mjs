import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { big, parseUsdg, parseE18, formatUnits, formatUsdg, formatE18, money, signed, percentChange, shortAddress } from '../src/live/units.js';
import { ApiError, request, query } from '../src/live/api.js';
import { ORDER_KIND, cancelMessage, entryOrder, newNonce, orderBody, orderTypedData, permitTypedData, protectionOrder, protectionProblem } from '../src/live/orders.js';
import { friendlyError, isUserRejection, revertName } from '../src/live/errors.js';
import { claimPayout, closeAtMarkTx, closeTrade, counterDeposit, depositCollateral, openTrade, placeOrder, cancelOrderRequest, addMarginTx, toQuoteArg } from '../src/live/trade.js';

const account = privateKeyToAccount('0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e');
const EXCHANGE = '0x1111111111111111111111111111111111111111';
const VAULT = '0x2222222222222222222222222222222222222222';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const DESK = '0x3333333333333333333333333333333333333333';
const MARKET = `0x${'ab'.repeat(32)}`;

// ---------------------------------------------------------------- units

test('parseUnits accepts plain decimals within the precision and nothing else', () => {
  assert.equal(parseUsdg('12.5'), 12_500_000n);
  assert.equal(parseUsdg('0.000001'), 1n);
  assert.equal(parseUsdg('.5'), 500_000n);
  assert.equal(parseUsdg('7.'), 7_000_000n);
  for (const bad of ['', '.', '-1', '1e3', '1.0000001', 'abc', '1,5', ' ', null, undefined]) assert.equal(parseUsdg(bad), null, String(bad));
  assert.equal(parseE18('1.5'), 1_500_000_000_000_000_000n);
});

test('formatUnits is exact, truncates rather than rounds, and keeps the sign', () => {
  assert.equal(formatUsdg(1_234_567n, 2), '1.23');
  assert.equal(formatUsdg(1_239_999n, 2), '1.23');
  assert.equal(formatUsdg(-1_500_000n, 2), '-1.50');
  assert.equal(formatUsdg(-1n, 2), '0.00'); // never "-0.00"
  assert.equal(formatE18(1_234_500_000_000_000_000n, 4), '1.2345');
  assert.equal(formatUnits(5n, 0, 0), '5');
});

test('big() reads strings, numbers and bigints, and treats everything else as zero', () => {
  assert.equal(big('123'), 123n);
  assert.equal(big('-5'), -5n);
  assert.equal(big(7), 7n);
  assert.equal(big(9n), 9n);
  for (const v of [null, undefined, '', 'x', 1.5, NaN, {}]) assert.equal(big(v), 0n);
});

test('display helpers', () => {
  assert.equal(money(1234.5), '1,234.50');
  assert.equal(signed(-3.2), '−3.20');
  assert.equal(signed(3.2), '+3.20');
  assert.equal(percentChange(110, 100), 10);
  assert.equal(percentChange(5, 0), 0);
  assert.equal(shortAddress('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
});

// ---------------------------------------------------------------- api client

const fakeFetch = (status, payload, record) => async (url, init) => {
  record?.push({ url, init });
  return { ok: status < 400, status, statusText: 'x', text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) };
};

test('request returns parsed JSON and sends bigint bodies as strings', async () => {
  const seen = [];
  const out = await request('POST', '/v1/x', { body: { a: 5n }, fetchImpl: fakeFetch(200, { ok: true }, seen), base: 'http://api' });
  assert.deepEqual(out, { ok: true });
  assert.equal(seen[0].url, 'http://api/v1/x');
  assert.equal(seen[0].init.body, '{"a":"5"}');
  assert.equal(seen[0].init.headers['content-type'], 'application/json');
});

test('request turns an error body into an ApiError that keeps the body', async () => {
  await assert.rejects(request('GET', '/v1/x', { fetchImpl: fakeFetch(422, { error: 'leverage_exceeded', message: 'm' }), base: '' }), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 422);
    assert.equal(e.body.error, 'leverage_exceeded');
    return true;
  });
});

test('request survives a non-JSON error page and an unreachable service', async () => {
  await assert.rejects(request('GET', '/v1/x', { fetchImpl: fakeFetch(502, '<html>bad gateway</html>'), base: '' }), (e) => e.status === 502);
  await assert.rejects(request('GET', '/v1/x', { fetchImpl: async () => { throw new TypeError('fetch failed'); }, base: '' }), (e) => e.status === 0 && /Cannot reach/.test(e.message));
});

test('query skips empty values', () => {
  assert.equal(query({ a: 1, b: undefined, c: null, d: '', e: 'x y' }), '?a=1&e=x+y');
  assert.equal(query({}), '');
});

// ---------------------------------------------------------------- orders

const base = { marketId: MARKET, trader: account.address, validAfter: 1000n, expiry: 9999n, nonce: 7n };

test('entry orders: direction of the trigger follows the side and the type', () => {
  const t = (type, side) => entryOrder({ ...base, type, side, sizeE18: 5n, triggerE18: 100n, marginUsdg: 50n }).triggerAbove;
  assert.equal(t('limit', 'long'), false); // buy when the price falls to the limit
  assert.equal(t('limit', 'short'), true); // sell when it rises to the limit
  assert.equal(t('stop', 'long'), true); // buy the breakout
  assert.equal(t('stop', 'short'), false); // sell the breakdown
});

test('entry orders: short size is negative, long positive, never reduce-only', () => {
  const long = entryOrder({ ...base, type: 'limit', side: 'long', sizeE18: 5n, triggerE18: 1n, marginUsdg: 1n });
  const short = entryOrder({ ...base, type: 'stop', side: 'short', sizeE18: 5n, triggerE18: 1n, marginUsdg: 1n });
  assert.equal(long.sizeDeltaE18, 5n);
  assert.equal(short.sizeDeltaE18, -5n);
  assert.equal(long.reduceOnly, false);
  assert.equal(long.sizeBps, 0);
  assert.equal(long.kind, ORDER_KIND.limit);
  assert.equal(short.kind, ORDER_KIND.stop);
});

test('protection orders: close the whole position, reduce-only, correct trigger direction', () => {
  const p = (kind, positionSide) => protectionOrder({ ...base, kind, positionSide, triggerE18: 100n });
  assert.equal(p('takeProfit', 'long').triggerAbove, true);
  assert.equal(p('takeProfit', 'short').triggerAbove, false);
  assert.equal(p('stopLoss', 'long').triggerAbove, false);
  assert.equal(p('stopLoss', 'short').triggerAbove, true);
  const o = p('stopLoss', 'long');
  assert.equal(o.sizeBps, 10_000);
  assert.equal(o.sizeDeltaE18, 0n);
  assert.equal(o.reduceOnly, true);
  assert.equal(o.marginUsdg, 0n);
  assert.equal(o.kind, ORDER_KIND.stopLoss);
  assert.throws(() => protectionOrder({ ...base, kind: 'limit', positionSide: 'long', triggerE18: 1n }));
});

test('a signed order recovers to the trader, and the API body carries strings', async () => {
  const order = entryOrder({ ...base, type: 'limit', side: 'short', sizeE18: 3n * 10n ** 18n, triggerE18: 25n * 10n ** 18n, marginUsdg: 100_000_000n });
  const typed = orderTypedData(4663, EXCHANGE, order);
  const signature = await account.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature }), account.address);
  const body = orderBody(order, signature);
  assert.equal(body.sizeDeltaE18, (-3n * 10n ** 18n).toString());
  assert.equal(body.nonce, '7');
  assert.equal(typeof body.kind, 'number');
  assert.equal(body.signature, signature);
  assert.doesNotThrow(() => JSON.stringify(body)); // no bigint left
});

test('a permit signature recovers to the owner', async () => {
  const typed = permitTypedData({ chainId: 4663, usdg: USDG, owner: account.address, spender: EXCHANGE, value: 5n, nonce: 0n, deadline: 99n });
  const signature = await account.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature }), account.address);
});

test('cancel message is signable and recoverable', async () => {
  const text = cancelMessage(42n);
  assert.equal(text, 'plankton:cancel-order:42');
  assert.equal(await recoverMessageAddress({ message: text, signature: await account.signMessage({ message: text }) }), account.address);
});

test('newNonce is a uint64 and differs between calls', () => {
  const a = newNonce();
  const b = newNonce();
  assert.ok(a >= 0n && a < 2n ** 64n);
  assert.notEqual(a, b);
});

test('protectionProblem mirrors the exchange rules', () => {
  assert.equal(protectionProblem('long', 100, '110', '90'), null);
  assert.match(protectionProblem('long', 100, '90', ''), /above/);
  assert.match(protectionProblem('long', 100, '', '110'), /below/);
  assert.match(protectionProblem('short', 100, '110', ''), /below/);
  assert.match(protectionProblem('short', 100, '', '90'), /above/);
  assert.match(protectionProblem('long', 100, '-1', ''), /positive/);
  assert.equal(protectionProblem('long', 100, '', ''), null);
});

// ---------------------------------------------------------------- errors

test('errors are turned into plain sentences', () => {
  assert.match(friendlyError({ code: 4001, message: 'User rejected the request.' }), /Cancelled in your wallet/);
  assert.equal(isUserRejection({ cause: { name: 'UserRejectedRequestError' } }), true);
  assert.match(friendlyError(new ApiError(422, 'leverage_exceeded', { error: 'leverage_exceeded' })), /leverage/i);
  assert.match(friendlyError(new ApiError(0, 'Cannot reach the PlanktonOTC service.')), /Cannot reach/);
  assert.match(friendlyError(new ApiError(429, 'rate limit reached')), /Too many/);
  assert.match(friendlyError({ message: 'execution reverted: Slippage()', data: { errorName: 'Slippage' } }), /moved too far/);
  assert.match(friendlyError({ message: 'insufficient funds for gas' }), /gas/);
  assert.equal(revertName({ cause: { data: { errorName: 'QuoteExpired' } } }), 'QuoteExpired');
  assert.equal(revertName({ message: 'The contract function reverted with Expired' }), 'Expired');
  assert.match(friendlyError(new ApiError(503, 'quote_service_unavailable')), /quote service/i);
});

// ---------------------------------------------------------------- trade flows (fake wallet, fake API)

function harness({ quotes, state = { usdgNonce: '3' }, signFail, sendFail } = {}) {
  const log = [];
  let quoteCalls = 0;
  const ctx = {
    address: account.address,
    chainId: 4663,
    contracts: { exchange: EXCHANGE, vault: VAULT, usdg: USDG, payoutDesk: DESK },
    api: {
      async get(path) {
        log.push(['get', path]);
        if (path === '/v1/config') return { chainTimeSec: '5000' };
        if (path.endsWith('/state')) return state;
        throw new Error(`unexpected GET ${path}`);
      },
      async post(path, body) {
        log.push(['post', path, body]);
        if (path.startsWith('/v1/quote')) {
          const q = typeof quotes === 'function' ? quotes(quoteCalls++, path) : quotes[Math.min(quoteCalls++, quotes.length - 1)];
          if (q instanceof Error) throw q;
          return q;
        }
        return { ok: true };
      },
      async del(path, body) {
        log.push(['del', path, body]);
        return { cancelledOffChain: true, onChain: { to: EXCHANGE, data: '0x' } };
      },
    },
    async signTypedData(typed) {
      if (signFail) throw signFail;
      log.push(['signTyped', typed.primaryType, typed.message]);
      return account.signTypedData(typed);
    },
    async signMessage(text) {
      log.push(['signMessage', text]);
      return account.signMessage({ message: text });
    },
    async sendTx(call) {
      const fail = sendFail?.(call, log.filter((l) => l[0] === 'send').length);
      if (fail) throw fail;
      log.push(['send', call.functionName, call.args]);
      return `0x${'cd'.repeat(32)}`;
    },
    async waitForReceipt(hash) {
      log.push(['receipt', hash]);
    },
    steps: [],
  };
  ctx.onStep = (name) => ctx.steps.push(name);
  return { ctx, log };
}

const wireQuote = (extra = {}) => ({
  marketId: MARKET, trader: account.address, sizeDeltaE18: '1000000000000000000', execPriceE18: '50000000000000000000', feeUsdg: '40000',
  maxLeverageE18: '3000000000000000000', markSequence: '9', nonce: '12345', expiry: '5020', ...extra,
});
const permitFor = (value) => ({ message: { owner: account.address, spender: EXCHANGE, value: String(value), nonce: '3', deadline: '5600' } });
const covered = () => ({ quote: wireQuote(), signature: '0xsig', permit: null, reducing: false });
const needsPermit = (value = 100_040_000) => ({ quote: wireQuote(), signature: '0xsig', permit: permitFor(value), reducing: false });

test('open with enough deposited collateral: one quote, one execute, no permit', async () => {
  const { ctx, log } = harness({ quotes: [covered()] });
  await openTrade(ctx, { symbol: 'USAR', sizeDeltaE18: 10n ** 18n, marginUsdg: 100_000_000n });
  const sends = log.filter((l) => l[0] === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], 'execute');
  assert.equal(sends[0][2][2], 100_000_000n);
  assert.equal(log.some((l) => l[0] === 'signTyped'), false);
  assert.deepEqual(ctx.steps, ['quote', 'wallet', 'confirming', 'done']);
});

test('open from the wallet: sign a permit for the shortfall plus a buffer, re-quote, then permitAndExecute', async () => {
  const { ctx, log } = harness({ quotes: [needsPermit(), needsPermit()] });
  await openTrade(ctx, { symbol: 'USAR', sizeDeltaE18: 10n ** 18n, marginUsdg: 100_000_000n });
  const signed = log.find((l) => l[0] === 'signTyped');
  assert.equal(signed[1], 'Permit');
  const value = BigInt(signed[2].value);
  assert.ok(value > 100_040_000n && value <= 100_040_000n + 1_100_000n, `permit value ${value}`);
  assert.equal(log.filter((l) => l[0] === 'post').length, 2); // fetched before and after the permit prompt
  const send = log.find((l) => l[0] === 'send');
  assert.equal(send[1], 'permitAndExecute');
  assert.equal(send[2][0], value); // deposit amount equals the permitted amount
  assert.equal(send[2][1], 5600n);
  assert.ok([27, 28].includes(send[2][2]));
  assert.equal(send[2][7], 100_000_000n);
  assert.deepEqual(ctx.steps, ['quote', 'sign-permit', 'quote', 'wallet', 'confirming', 'done']);
});

test('a fee that outgrows the permit buffer triggers a second permit', async () => {
  const { ctx, log } = harness({ quotes: [needsPermit(100_000_000), needsPermit(150_000_000), needsPermit(150_000_000)] });
  await openTrade(ctx, { symbol: 'USAR', sizeDeltaE18: 10n ** 18n, marginUsdg: 100_000_000n });
  assert.equal(log.filter((l) => l[0] === 'signTyped').length, 2);
  const send = log.find((l) => l[0] === 'send');
  assert.ok(send[2][0] >= 150_000_000n);
});

test('an expired quote at send time is replaced and the send is retried', async () => {
  const expired = Object.assign(new Error('reverted'), { data: { errorName: 'QuoteExpired' } });
  const { ctx, log } = harness({ quotes: [covered(), covered()], sendFail: (_c, n) => (n === 0 && !ctx.failed ? ((ctx.failed = true), expired) : null) });
  await openTrade(ctx, { symbol: 'USAR', sizeDeltaE18: 10n ** 18n, marginUsdg: 100_000_000n });
  assert.equal(log.filter((l) => l[0] === 'post').length, 2);
  assert.equal(log.filter((l) => l[0] === 'send').length, 1);
});

test('an error that is not a stale quote is not retried', async () => {
  const boom = Object.assign(new Error('nope'), { data: { errorName: 'Slippage' } });
  const { ctx } = harness({ quotes: [covered()], sendFail: () => boom });
  await assert.rejects(openTrade(ctx, { symbol: 'USAR', sizeDeltaE18: 1n, marginUsdg: 1n }), (e) => e === boom);
});

test('rejecting the permit in the wallet stops everything before any transaction', async () => {
  const { ctx, log } = harness({ quotes: [needsPermit()], signFail: Object.assign(new Error('User rejected the request.'), { code: 4001 }) });
  await assert.rejects(openTrade(ctx, { symbol: 'USAR', sizeDeltaE18: 1n, marginUsdg: 1n }), isUserRejection);
  assert.equal(log.some((l) => l[0] === 'send'), false);
});

test('close sends execute with zero margin and the close quote', async () => {
  const { ctx, log } = harness({ quotes: [{ quote: wireQuote({ sizeDeltaE18: '-1000000000000000000' }), signature: '0xsig', permit: null, reducing: true }] });
  await closeTrade(ctx, { symbol: 'USAR', sizeBps: 2500 });
  assert.deepEqual(log[0], ['post', '/v1/quote/close', { market: 'USAR', trader: account.address, sizeBps: 2500 }]);
  const send = log.find((l) => l[0] === 'send');
  assert.equal(send[1], 'execute');
  assert.equal(send[2][2], 0n);
  assert.equal(send[2][0].sizeDeltaE18, -(10n ** 18n));
});

test('when the quote service is down, the close error carries the on-chain fallback, and closeAtMark needs no API', async () => {
  const down = new ApiError(503, 'no_mark', { error: 'no_mark', closeAtMark: { to: EXCHANGE, data: '0x1' } });
  const { ctx, log } = harness({ quotes: [down] });
  await assert.rejects(closeTrade(ctx, { symbol: 'USAR', sizeBps: 10_000 }), (e) => e.body.closeAtMark.to === EXCHANGE);
  await closeAtMarkTx(ctx, { marketId: MARKET, sizeBps: 10_000 });
  const send = log.find((l) => l[0] === 'send');
  assert.equal(send[1], 'closeAtMark');
  assert.deepEqual(send[2], [MARKET, 10_000]);
});

test('deposit signs a permit with the chain nonce and calls depositWithPermit', async () => {
  const { ctx, log } = harness({ state: { usdgNonce: '8' } });
  await depositCollateral(ctx, 250_000_000n);
  const permit = log.find((l) => l[0] === 'signTyped');
  assert.equal(permit[2].nonce, 8n);
  assert.equal(permit[2].spender, EXCHANGE);
  assert.equal(permit[2].deadline, 5600n); // chain time 5000 + 600
  const send = log.find((l) => l[0] === 'send');
  assert.equal(send[1], 'depositWithPermit');
  assert.equal(send[2][0], 250_000_000n);
});

test('adding margin deposits only the missing amount first', async () => {
  const { ctx, log } = harness();
  await addMarginTx(ctx, { marketId: MARKET, amountUsdg: 100_000_000n, collateralUsdg: 40_000_000n });
  const sends = log.filter((l) => l[0] === 'send');
  assert.deepEqual(sends.map((s) => s[1]), ['depositWithPermit', 'addMargin']);
  assert.equal(sends[0][2][0], 60_000_000n);
  assert.deepEqual(sends[1][2], [MARKET, 100_000_000n]);
  const { ctx: ctx2, log: log2 } = harness();
  await addMarginTx(ctx2, { marketId: MARKET, amountUsdg: 10n, collateralUsdg: 10n });
  assert.deepEqual(log2.filter((l) => l[0] === 'send').map((s) => s[1]), ['addMargin']);
});

test('placing an order signs it and posts it; nothing is sent on-chain', async () => {
  const { ctx, log } = harness();
  const order = protectionOrder({ ...base, kind: 'stopLoss', positionSide: 'long', triggerE18: 40n * 10n ** 18n });
  await placeOrder(ctx, order);
  assert.equal(log.some((l) => l[0] === 'send'), false);
  const post = log.find((l) => l[0] === 'post');
  assert.equal(post[1], '/v1/orders');
  assert.equal(post[2].kind, ORDER_KIND.stopLoss);
  assert.equal(post[2].sizeBps, 10_000);
});

test('cancelling signs the cancel text and calls DELETE with the trader', async () => {
  const { ctx, log } = harness();
  const out = await cancelOrderRequest(ctx, 77n);
  assert.deepEqual(log.find((l) => l[0] === 'signMessage'), ['signMessage', 'plankton:cancel-order:77']);
  const del = log.find((l) => l[0] === 'del');
  assert.equal(del[1], '/v1/orders/77');
  assert.equal(del[2].trader, account.address);
  assert.equal(out.cancelledOffChain, true);
});

test('Counter deposit permits the vault, not the exchange', async () => {
  const { ctx, log } = harness();
  await counterDeposit(ctx, 5_000_000_000n);
  assert.equal(log.find((l) => l[0] === 'signTyped')[2].spender, VAULT);
  const send = log.find((l) => l[0] === 'send');
  assert.equal(send[1], 'requestDepositWithPermit');
  assert.equal(send[2][0], 5_000_000_000n);
});

test('claim sends the payout id as a bigint to the payout desk', async () => {
  const { ctx, log } = harness();
  await claimPayout(ctx, '12');
  const send = log.find((l) => l[0] === 'send');
  assert.equal(send[1], 'claim');
  assert.deepEqual(send[2], [12n]);
});

test('toQuoteArg turns every wire string into the bigint the contract struct needs', () => {
  const q = toQuoteArg(wireQuote());
  for (const k of ['sizeDeltaE18', 'execPriceE18', 'feeUsdg', 'maxLeverageE18', 'markSequence', 'nonce', 'expiry']) assert.equal(typeof q[k], 'bigint', k);
  assert.equal(q.marketId, MARKET);
});
