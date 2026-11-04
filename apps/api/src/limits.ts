import { timingSafeEqual } from 'node:crypto';

/** A fixed-window request counter per key, held in memory. Enough to stop one client from draining the signers' budgets. */
export function createRateLimiter(windowMs = 60_000, maxKeys = 100_000) {
  const hits = new Map<string, { n: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref?.();

  return function check(key: string, limit: number, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    if (hits.size >= maxKeys) hits.clear(); // under a flood of distinct keys, forgetting everyone beats running out of memory
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { n: 0, resetAt: now + windowMs };
      hits.set(key, h);
    }
    h.n++;
    return { ok: h.n <= limit, retryAfterSec: Math.max(1, Math.ceil((h.resetAt - now) / 1000)) };
  };
}

/**
 * The caller's address. Forwarding headers can be forged by anyone who reaches the API directly, so they are used only
 * when TRUST_PROXY is on (the API sits behind a proxy that sets them). The website's own server forwards every visitor's
 * calls from one address, so it names the visitor in x-visitor-ip, believed only alongside the shared WEB_PROXY_TOKEN.
 */
export function clientIp(headers: Headers, socketIp: string | undefined, trustProxy: boolean, webProxyToken?: string): string {
  if (webProxyToken && tokenMatches(headers.get('x-web-proxy-token'), webProxyToken)) {
    const visitor = headers.get('x-visitor-ip')?.trim();
    if (visitor) return visitor;
  }
  if (trustProxy) {
    const real = headers.get('x-real-ip')?.trim();
    if (real) return real;
    const fwd = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return socketIp ?? 'unknown';
}

/** Constant-time check of the internal token header. */
export function isInternal(headers: Headers, token: string | undefined): boolean {
  if (!token) return false;
  return tokenMatches(headers.get('x-internal-token'), token);
}

function tokenMatches(given: string | null, token: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Origins to allow, from a comma-separated list. In development an empty list means any origin. */
export function corsOrigins(list: string | undefined, production: boolean): string[] | '*' | [] {
  const origins = (list ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length > 0) return origins;
  return production ? [] : '*';
}
