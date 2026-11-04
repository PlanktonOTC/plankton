import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

async function start(opts) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plankton-web-'));
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
  await fs.writeFile(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    if (opts?.fail) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ echoed: init.body ? JSON.parse(Buffer.from(init.body).toString()) : null }), {
      status: 201,
      headers: { 'content-type': 'application/json', 'set-cookie': 'x=1', 'retry-after': '3' },
    });
  };
  const server = createServer({ root, apiOrigin: 'https://api.example/', proxyToken: 't'.repeat(40), trustProxy: true, fetch });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => new Promise((r) => server.close(r)) };
}

test('/api calls are made by the server, with only safe headers and the visitor named for the rate limit', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/api/v1/quote/trade?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=secret', 'x-forwarded-for': '5.6.7.8, 10.0.0.1', 'x-web-proxy-token': 'forged', 'x-visitor-ip': '1.1.1.1', 'x-internal-token': 'forged' },
      body: JSON.stringify({ market: 'RCAT' }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { echoed: { market: 'RCAT' } });
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('retry-after'), '3');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const [call] = s.calls;
    assert.equal(call.url, 'https://api.example/v1/quote/trade?x=1');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['x-visitor-ip'], '5.6.7.8');
    assert.equal(call.headers['x-web-proxy-token'], 't'.repeat(40));
    for (const h of ['cookie', 'x-forwarded-for', 'x-internal-token']) assert.equal(call.headers[h], undefined, h);
  } finally {
    await s.close();
  }
});

test('an unreachable API is a 502 JSON error the site can show; oversized bodies never leave the server', async () => {
  const s = await start({ fail: true });
  try {
    const res = await fetch(`${s.base}/api/v1/markets`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /cannot reach/);
    const big = await fetch(`${s.base}/api/v1/orders`, { method: 'POST', body: 'x'.repeat(70 * 1024) }).catch(() => null);
    if (big) assert.equal(big.status, 413);
    assert.equal(s.calls.length, 1);
  } finally {
    await s.close();
  }
});

test('the site is served with app routes falling back to index.html and fingerprinted assets cached forever', async () => {
  const s = await start();
  try {
    const page = await fetch(`${s.base}/trade/RCAT`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>app<\/title>/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const asset = await fetch(`${s.base}/assets/app-abc123.js`);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(`${s.base}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/..%2f..%2fetc%2fpasswd`)).status, 403);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});
