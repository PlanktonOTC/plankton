// Production server for the trading site: serves the built files in dist/ and forwards /api/* to the PlanktonOTC API from
// the server, so the browser only ever talks to this one origin (no CORS, and the API's address is never in the page).
//
//   API_ORIGIN       where the API lives (default https://plankton-gkmt.onrender.com)
//   WEB_PROXY_TOKEN  shared with the API; lets it rate-limit each visitor by their own address instead of this server's
//   TRUST_PROXY      true when this server sits behind a proxy that sets x-forwarded-for (Render does)
//   PORT             default 4173
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};
// Only these travel between the browser and the API. Cookies, auth and forwarding headers from the browser never do.
const REQUEST_HEADERS = ['content-type', 'accept', 'accept-language'];
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'etag'];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE']);
const MAX_BODY = 64 * 1024; // the API's own limit; its largest legitimate body is a signed order
const API_TIMEOUT_MS = 60_000; // a quote can wait a few seconds for a fresh mark to go on-chain

/** The visitor's address: from the proxy's x-forwarded-for when trusted, else the socket. */
export function visitorIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function proxy(req, res, url, cfg) {
  if (!METHODS.has(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
  const headers = {};
  for (const h of REQUEST_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  headers['x-visitor-ip'] = visitorIp(req, cfg.trustProxy);
  if (cfg.proxyToken) headers['x-web-proxy-token'] = cfg.proxyToken;

  let body;
  if (req.method === 'POST' || req.method === 'DELETE') {
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, err.status ?? 400, { error: err.status === 413 ? 'request too large' : 'bad request' });
    }
  }

  let upstream;
  try {
    upstream = await cfg.fetch(`${cfg.apiOrigin}${url.pathname.slice('/api'.length) || '/'}${url.search}`, {
      method: req.method,
      headers,
      body: body?.length ? body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError';
    return sendJson(res, timedOut ? 504 : 502, { error: timedOut ? 'the PlanktonOTC service took too long to answer' : 'cannot reach the PlanktonOTC service' });
  }

  const out = { ...SECURITY_HEADERS };
  for (const h of RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  out['cache-control'] ??= 'no-store';
  const data = Buffer.from(await upstream.arrayBuffer());
  out['content-length'] = data.length;
  res.writeHead(upstream.status, out);
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function serveFile(req, res, url, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, SECURITY_HEADERS);
    return res.end();
  }
  let relative;
  try {
    relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    return res.end('Bad request');
  }
  let file = path.resolve(root, relative || 'index.html');
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('Forbidden');
  }
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // /trade and /docs are pages inside the one app: a path that is not a file loads index.html, a missing file is a 404.
    if (path.extname(file)) {
      res.writeHead(404, SECURITY_HEADERS);
      return res.end('Not found');
    }
    file = path.join(root, 'index.html');
  }
  let data;
  try {
    data = await fs.readFile(file);
  } catch {
    res.writeHead(404, SECURITY_HEADERS);
    return res.end('Not found');
  }
  // Vite fingerprints everything under /assets, so those never change; the page itself must always be revalidated.
  const immutable = url.pathname.startsWith('/assets/');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

export function createServer({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist'),
  apiOrigin = 'https://plankton-gkmt.onrender.com',
  proxyToken,
  trustProxy = false,
  fetch = globalThis.fetch,
} = {}) {
  const cfg = { apiOrigin: apiOrigin.replace(/\/$/, ''), proxyToken, trustProxy, fetch };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await proxy(req, res, url, cfg);
      return await serveFile(req, res, url, root);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const port = Number(env.PORT) || 4173;
  if (!env.WEB_PROXY_TOKEN) console.warn('WEB_PROXY_TOKEN is not set: the API will rate-limit every visitor as this one server');
  createServer({
    apiOrigin: env.API_ORIGIN || undefined,
    proxyToken: env.WEB_PROXY_TOKEN || undefined,
    trustProxy: env.TRUST_PROXY === 'true',
  }).listen(port, env.HOST || '0.0.0.0', () => console.log(`PlanktonOTC site on :${port}, API at ${env.API_ORIGIN || 'https://plankton-gkmt.onrender.com'}`));
}
