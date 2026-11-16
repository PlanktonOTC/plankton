import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KIND_LABEL, MARKET_ORDER_LIFETIME_SEC, MARKET_SLIPPAGE_BPS, ORDER_KIND, canGoGasless, marketCloseOrder, marketOrder, orderTypedData } from '../src/live/orders.js';
import { gaslessOrder } from '../src/live/trade.js';

const account = privateKeyToAccount('0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e');
const EXCHANGE = '0x1111111111111111111111111111111111111111';
const MARKET = `0x${'ab'.repeat(32)}`;
const NOW = 1_800_000_000n;

test('a gasless market order has no trigger, lapses after two minutes and signs like any order', async () => {
  const o = marketOrder({ marketId: MARKET, trader: account.address, sizeDeltaE18: -2n * 10n ** 17n, marginUsdg: 1_000_000n, validAfter: NOW, nonce: 7n });
  assert.equal(o.kind, ORDER_KIND.market);
  assert.equal(KIND_LABEL[o.kind], 'Market');
  assert.equal(o.triggerE18, 0n);
  assert.equal(o.reduceOnly, false);
  assert.equal(o.sizeDeltaE18, -2n * 10n ** 17n);
  assert.equal(o.maxSlippageBps, MARKET_SLIPPAGE_BPS);
  assert.equal(o.expiry - o.validAfter, MARKET_ORDER_LIFETIME_SEC);

  const typed = orderTypedData(4663, EXCHANGE, o);
  const sig = await account.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature: sig }), account.address);
});

test('a gasless close is reduce-only by share of the position and needs no margin', () => {
  const o = marketCloseOrder({ marketId: MARKET, trader: account.address, sizeBps: 10_000, validAfter: NOW, nonce: 8n });
  assert.equal(o.reduceOnly, true);
  assert.equal(o.sizeBps, 10_000);
  assert.equal(o.sizeDeltaE18, 0n);
  assert.equal(o.marginUsdg, 0n);
  assert.equal(o.triggerE18, 0n);
  assert.throws(() => marketCloseOrder({ marketId: MARKET, trader: account.address, sizeBps: 0, validAfter: NOW, nonce: 9n }));
  assert.throws(() => marketCloseOrder({ marketId: MARKET, trader: account.address, sizeBps: 10_001, validAfter: NOW, nonce: 9n }));
});

test('market orders go gasless only when deposited collateral covers margin, fee and a small buffer', () => {
  assert.equal(canGoGasless(1.02, 1, 0.001), true);
  assert.equal(canGoGasless(1.005, 1, 0.001), false);
  assert.equal(canGoGasless(0, 1, 0.001), false);
});

function ctxWith(statuses) {
  const calls = { posted: [], steps: [] };
  let i = 0;
  const ctx = {
    chainId: 4663,
    contracts: { exchange: EXCHANGE },
    signTypedData: (typed) => account.signTypedData(typed),
    onStep: (name, detail) => calls.steps.push(detail ? `${name}:${detail}` : name),
    api: {
      post: async (path, body) => {
        calls.posted.push({ path, body });
        return { ok: true };
      },
      get: async (path) => {
        calls.lastGet = path;
        return statuses[Math.min(i++, statuses.length - 1)];
      },
    },
  };
  return { ctx, calls };
}

const order = () => marketOrder({ marketId: MARKET, trader: account.address, sizeDeltaE18: 10n ** 17n, marginUsdg: 1_000_000n, validAfter: NOW, nonce: 42n });

test('gaslessOrder signs, submits and waits for the keeper fill, returning its transaction', async () => {
  const { ctx, calls } = ctxWith([{ status: 'open' }, { status: 'open' }, { status: 'filled', fillTx: '0xabc' }]);
  const hash = await gaslessOrder(ctx, order(), { pollMs: 0, wait: async () => {} });
  assert.equal(hash, '0xabc');
  assert.equal(calls.posted[0].path, '/v1/orders');
  assert.equal(calls.lastGet, `/v1/orders/${account.address}/42`);
  assert.deepEqual(calls.steps, ['sign-order', 'submit', 'keeper', 'done:0xabc']);
});

test('gaslessOrder explains why an order did not fill, and gives up waiting without cancelling', async () => {
  const lapsed = ctxWith([{ status: 'expired' }]);
  await assert.rejects(gaslessOrder(lapsed.ctx, order(), { wait: async () => {} }), /lapsed before it could fill/);

  const short = ctxWith([{ status: 'failed', failReason: 'InsufficientCollateral' }]);
  await assert.rejects(gaslessOrder(short.ctx, order(), { wait: async () => {} }), /Not enough deposited USDG/);

  const slow = ctxWith([{ status: 'open' }]);
  await assert.rejects(gaslessOrder(slow.ctx, order(), { timeoutMs: -1, wait: async () => {} }), /stays live for 2 minutes/);
});
