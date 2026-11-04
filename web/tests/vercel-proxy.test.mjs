import test from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST } from '../api/proxy.js';

function stubFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    return respond(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test('Vercel forwards /api calls to the API from the server, naming the visitor', async (t) => {
  process.env.API_ORIGIN = 'https://api.example';
  process.env.WEB_PROXY_TOKEN = 'p'.repeat(40);
  const calls = stubFetch(t, () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } }));

  // vercel.json rewrites /api/v1/markets?x=1 to /api/proxy?__path=v1/markets&x=1
  const res = await GET(new Request('https://site.example/api/proxy?__path=v1/markets&x=1', { headers: { 'x-real-ip': '5.6.7.8', cookie: 'secret=1', 'x-internal-token': 'forged' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const [call] = calls;
  assert.equal(call.url, 'https://api.example/v1/markets?x=1');
  assert.equal(call.headers['x-visitor-ip'], '5.6.7.8');
  assert.equal(call.headers['x-web-proxy-token'], 'p'.repeat(40));
  for (const h of ['cookie', 'x-internal-token']) assert.equal(call.headers[h], undefined, h);
});

test('Vercel passes order bodies through and refuses oversized ones', async (t) => {
  process.env.API_ORIGIN = 'https://api.example';
  const calls = stubFetch(t, async (_url, init) => new Response(new TextDecoder().decode(init.body), { status: 201, headers: { 'content-type': 'application/json' } }));

  const res = await POST(new Request('https://site.example/api/proxy?__path=v1/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nonce":"1"}' }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { nonce: '1' });
  assert.equal(calls[0].url, 'https://api.example/v1/orders');

  const big = await POST(new Request('https://site.example/api/proxy?__path=v1/orders', { method: 'POST', body: 'x'.repeat(70 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal(calls.length, 1);
});

test('an unreachable API is a 502 JSON error the site can show', async (t) => {
  stubFetch(t, () => {
    throw new TypeError('fetch failed');
  });
  const res = await GET(new Request('https://site.example/api/proxy?__path=health'));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /cannot reach/);
});
