import { describe, expect, test } from 'bun:test';
import { clientIp, corsOrigins, createRateLimiter, isInternal } from '../src/limits.ts';

describe('rate limiter', () => {
  test('lets a client through up to the limit, then refuses until the window ends', () => {
    const check = createRateLimiter(60_000);
    for (let i = 0; i < 3; i++) expect(check('a', 3, 1_000).ok).toBe(true);
    const refused = check('a', 3, 2_000);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSec).toBeGreaterThan(0);
    expect(check('a', 3, 61_001).ok).toBe(true); // a new window
  });

  test('clients are counted separately', () => {
    const check = createRateLimiter(60_000);
    expect(check('a', 1, 0).ok).toBe(true);
    expect(check('a', 1, 1).ok).toBe(false);
    expect(check('b', 1, 2).ok).toBe(true);
  });

  test('a flood of distinct keys cannot grow memory without bound', () => {
    const check = createRateLimiter(60_000, 10);
    for (let i = 0; i < 25; i++) check(`k${i}`, 5, 0);
    expect(check('k0', 1, 1).ok).toBe(true);
  });
});

describe('client address', () => {
  const h = new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1', 'x-real-ip': '8.8.8.8' });
  test('forwarding headers are ignored unless a trusted proxy is declared', () => {
    expect(clientIp(h, '1.2.3.4', false)).toBe('1.2.3.4');
  });
  test('behind a trusted proxy the real client address is used', () => {
    expect(clientIp(h, '1.2.3.4', true)).toBe('8.8.8.8');
    expect(clientIp(new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }), '1.2.3.4', true)).toBe('9.9.9.9');
    expect(clientIp(new Headers(), undefined, false)).toBe('unknown');
  });
});

describe('internal token and CORS', () => {
  test('the internal token must match exactly, and is off when none is configured', () => {
    const token = 'x'.repeat(20);
    expect(isInternal(new Headers({ 'x-internal-token': token }), token)).toBe(true);
    expect(isInternal(new Headers({ 'x-internal-token': 'y'.repeat(20) }), token)).toBe(false);
    expect(isInternal(new Headers(), token)).toBe(false);
    expect(isInternal(new Headers({ 'x-internal-token': 'anything' }), undefined)).toBe(false);
  });

  test('production allows no browser origin unless listed; development allows any', () => {
    expect(corsOrigins(undefined, true)).toEqual([]);
    expect(corsOrigins(undefined, false)).toBe('*');
    expect(corsOrigins('https://a.example, https://b.example', true)).toEqual(['https://a.example', 'https://b.example']);
  });
});
