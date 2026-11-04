// How the site forwards /api calls to the PlanktonOTC API from its own server, shared by web/server.mjs (any Node host)
// and web/api/proxy.js (Vercel). The browser only ever talks to the site's origin.

export const DEFAULT_API_ORIGIN = 'https://plankton-gkmt.onrender.com';
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};
// Only these travel between the browser and the API. Cookies, auth and forwarding headers from the browser never do.
export const REQUEST_HEADERS = ['content-type', 'accept', 'accept-language'];
export const RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'etag'];
export const METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE']);
export const MAX_BODY = 64 * 1024; // the API's own limit; its largest legitimate body is a signed order
export const API_TIMEOUT_MS = 60_000; // a quote can wait a few seconds for a fresh mark to go on-chain

const jsonError = (status, error) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Forward one web-standard Request to `${apiOrigin}${path}${search}`. The visitor is named in x-visitor-ip, which the
 * API believes only alongside the shared WEB_PROXY_TOKEN, so its rate limit stays per visitor.
 */
export async function forward(request, { apiOrigin = DEFAULT_API_ORIGIN, path, search = '', visitorIp, proxyToken, fetchImpl = globalThis.fetch }) {
  if (!METHODS.has(request.method)) return jsonError(405, 'method not allowed');
  const headers = {};
  for (const h of REQUEST_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  headers['x-visitor-ip'] = visitorIp || 'unknown';
  if (proxyToken) headers['x-web-proxy-token'] = proxyToken;

  let body;
  if (request.method === 'POST' || request.method === 'DELETE') {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length > MAX_BODY) return jsonError(413, 'request too large');
    if (buf.length) body = buf;
  }

  let upstream;
  try {
    upstream = await fetchImpl(`${apiOrigin.replace(/\/$/, '')}${path}${search}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    return err?.name === 'TimeoutError'
      ? jsonError(504, 'the PlanktonOTC service took too long to answer')
      : jsonError(502, 'cannot reach the PlanktonOTC service');
  }

  const out = { ...SECURITY_HEADERS };
  for (const h of RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  out['cache-control'] ??= 'no-store';
  const data = request.method === 'HEAD' ? null : await upstream.arrayBuffer();
  return new Response(data, { status: upstream.status, headers: out });
}
