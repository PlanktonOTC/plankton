import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { MAX_LADDER_STEPS, entryOrder, ladderProblem, ladderRungs } from '../src/live/orders.js';
import { placeLadder } from '../src/live/trade.js';

const account = privateKeyToAccount('0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e');
const MARKET = `0x${'ab'.repeat(32)}`;

test('a ladder spaces its steps evenly and shares the margin between them', () => {
  const r = ladderRungs({ fromPrice: 8.4, toPrice: 8.0, steps: 5, marginUsdg: 10_000_000n, leverage: 2, headroom: 1, digits: 2 });
  assert.deepEqual(r.map((x) => x.price), [8.4, 8.3, 8.2, 8.1, 8.0]);
  assert.ok(r.every((x) => x.marginUsdg === 2_000_000n));
  assert.ok(r.every((x) => x.notionalUsdg === 4_000_000n));
  // $4 of notional at $8 is half a share.
  assert.equal(r[4].sizeE18, 5n * 10n ** 17n);
  assert.equal(r[0].triggerE18, 84n * 10n ** 17n);
  assert.throws(() => ladderRungs({ fromPrice: 8, toPrice: 7, steps: MAX_LADDER_STEPS + 1, marginUsdg: 1n, leverage: 1 }));
  assert.throws(() => ladderRungs({ fromPrice: 8, toPrice: 7, steps: 1, marginUsdg: 1n, leverage: 1 }));
});

test('a buy ladder sits below the price, a sell ladder above it, and each step needs real margin', () => {
  const base = { markPrice: 10, steps: 3, marginUsdg: 3_000_000n };
  assert.equal(ladderProblem({ ...base, side: 'long', fromPrice: 9.9, toPrice: 9.5 }), null);
  assert.match(ladderProblem({ ...base, side: 'long', fromPrice: 10.1, toPrice: 9.5 }), /below the current price/);
  assert.equal(ladderProblem({ ...base, side: 'short', fromPrice: 10.1, toPrice: 10.5 }), null);
  assert.match(ladderProblem({ ...base, side: 'short', fromPrice: 9.9, toPrice: 10.5 }), /above the current price/);
  assert.match(ladderProblem({ ...base, side: 'long', fromPrice: 9.5, toPrice: 9.5 }), /two different prices/);
  assert.match(ladderProblem({ ...base, side: 'long', fromPrice: 0, toPrice: 9.5 }), /above 0/);
  assert.match(ladderProblem({ ...base, side: 'long', fromPrice: 9.9, toPrice: 9.5, marginUsdg: 200_000n }), /at least 0.10 USDG/);
});

function ctxSigningUntil(stopAt) {
  const posted = [];
  const steps = [];
  let signed = 0;
  return {
    posted,
    steps,
    ctx: {
      chainId: 4663,
      contracts: { exchange: '0x1111111111111111111111111111111111111111' },
      onStep: (s) => steps.push(s),
      signTypedData: async (typed) => {
        if (signed++ === stopAt) throw Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError' });
        return account.signTypedData(typed);
      },
      api: { post: async (path, body) => posted.push({ path, body }) },
    },
  };
}

const orders = ladderRungs({ fromPrice: 9.9, toPrice: 9.5, steps: 3, marginUsdg: 3_000_000n, leverage: 1.5, digits: 2 }).map((x, i) =>
  entryOrder({ type: 'limit', side: 'long', marketId: MARKET, trader: account.address, sizeE18: x.sizeE18, triggerE18: x.triggerE18, marginUsdg: x.marginUsdg, validAfter: 1n, expiry: 100n, nonce: BigInt(i + 1) }),
);

test('placeLadder signs and submits every step in order', async () => {
  const { ctx, posted, steps } = ctxSigningUntil(-1);
  await placeLadder(ctx, orders);
  assert.equal(posted.length, 3);
  assert.deepEqual(steps, ['ladder:1/3', 'ladder:2/3', 'ladder:3/3']);
  assert.ok(posted.every((p) => p.path === '/v1/orders'));
});

test('stopping part-way says how many steps are already live', async () => {
  const late = ctxSigningUntil(2);
  await assert.rejects(placeLadder(late.ctx, orders), /2 of 3 ladder orders were placed/);
  assert.equal(late.posted.length, 2);

  const first = ctxSigningUntil(0);
  await assert.rejects(placeLadder(first.ctx, orders), /User rejected/);
  assert.equal(first.posted.length, 0);
});
