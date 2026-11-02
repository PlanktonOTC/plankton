import { API_URL } from './env.js';

/** A failed call to the PlanktonOTC API. `status` is 0 when the service could not be reached at all. */
export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const bigintToString = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

/** One JSON request. `fetchImpl` and `base` exist so tests can run it without a network. */
export async function request(method, path, { body, signal, fetchImpl = globalThis.fetch, base = API_URL } = {}) {
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body, bigintToString),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the PlanktonOTC service. Check your connection and try again.');
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON error page from a proxy: fall through to the status text */
  }
  if (!res.ok) throw new ApiError(res.status, (json && json.error) || res.statusText || `HTTP ${res.status}`, json);
  return json;
}

export const apiGet = (path, opts) => request('GET', path, opts);
export const apiPost = (path, body, opts) => request('POST', path, { ...opts, body });
export const apiDelete = (path, body, opts) => request('DELETE', path, { ...opts, body });

/** Builds "?a=1&b=2" from an object, skipping undefined and null. */
export function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}
