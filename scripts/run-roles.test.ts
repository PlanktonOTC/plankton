import { describe, expect, test } from 'bun:test';
import { plan } from './run-roles.ts';

const keys = {
  PUBLISHER_PRIVATE_KEY: '0xpub',
  KEEPER_PRIVATE_KEY: '0xkeep',
  QUOTE_SIGNER_1_PRIVATE_KEY: '0xq1',
  MARK_SIGNER_1_PRIVATE_KEY: '0xm1',
  MARK_SIGNER_2_PRIVATE_KEY: '0xm2',
  MARK_SIGNER_3_PRIVATE_KEY: '0xm3',
};

describe('run-roles', () => {
  test('the first role takes the public port and the rest find each other on localhost', () => {
    const p = plan({ ...keys, PORT: '10000', ROLES: 'api,mark,signer-quote,signer-mark-1,signer-mark-2,keeper,indexer', EXTRA_MARK_SIGNER_URLS: 'https://m3.example' });
    const by = Object.fromEntries(p.map((c) => [c.name, c]));
    expect(by.api!.port).toBe(10000);
    expect(by.api!.env.QUOTE_SIGNER_URLS).toBe(`http://127.0.0.1:${by['signer-quote']!.port}`);
    expect(by.api!.env.MARK_SERVICE_URL).toBe(`http://127.0.0.1:${by.mark!.port}`);
    expect(by.mark!.env.MARK_SIGNER_URLS).toBe(`http://127.0.0.1:${by['signer-mark-1']!.port},http://127.0.0.1:${by['signer-mark-2']!.port},https://m3.example`);
    expect(by.keeper!.env.API_URL).toBe('http://127.0.0.1:10000');
    expect(new Set(p.map((c) => c.port)).size).toBe(p.length);
    for (const c of p) expect(c.env.PORT).toBe(String(c.port));
    expect(by['signer-mark-1']!.env.SIGNER_HOST).toBe('127.0.0.1');
    expect(by.api!.env.SIGNER_HOST).toBeUndefined();
  });

  test('the site can front the whole host, forwarding /api to the api role next to it', () => {
    const p = plan({ ...keys, PORT: '10000', ROLES: 'web,api,mark,signer-quote,signer-mark-1,signer-mark-2,keeper,indexer' });
    const by = Object.fromEntries(p.map((c) => [c.name, c]));
    expect(by.web!.port).toBe(10000);
    expect(by.web!.env.API_ORIGIN).toBe(`http://127.0.0.1:${by.api!.port}`);
    expect(by.keeper!.env.API_URL).toBe(`http://127.0.0.1:${by.api!.port}`);
  });

  test('each child sees only its own private key', () => {
    const p = plan({ ...keys, ROLES: 'api,mark,signer-quote,signer-mark-1,signer-mark-2,keeper,indexer' });
    const privateKeys = (env: Record<string, string>) => Object.entries(env).filter(([k]) => k.endsWith('PRIVATE_KEY'));
    const by = Object.fromEntries(p.map((c) => [c.name, privateKeys(c.env)]));
    expect(by.api).toEqual([]);
    expect(by.indexer).toEqual([]);
    expect(by.mark).toEqual([['PUBLISHER_PRIVATE_KEY', '0xpub']]);
    expect(by.keeper).toEqual([['KEEPER_PRIVATE_KEY', '0xkeep']]);
    expect(by['signer-quote']).toEqual([['SIGNER_PRIVATE_KEY', '0xq1']]);
    expect(by['signer-mark-2']).toEqual([['SIGNER_PRIVATE_KEY', '0xm2']]);
    expect(p.find((c) => c.name === 'signer-mark-2')!.env.SIGNER_ROLE).toBe('mark');
  });

  test('a lone signer host serves on the public port', () => {
    const [c] = plan({ ...keys, PORT: '10000', ROLES: 'signer-mark-3' });
    expect(c!.port).toBe(10000);
    expect(c!.env.SIGNER_PRIVATE_KEY).toBe('0xm3');
    expect(c!.env.SIGNER_HOST).toBeUndefined();
  });

  test('mistakes are refused before anything starts', () => {
    expect(() => plan({ ROLES: '' })).toThrow(/ROLES is empty/);
    expect(() => plan({ ROLES: 'api,nope' })).toThrow(/unknown role nope/);
    expect(() => plan({ ROLES: 'api,api' })).toThrow(/twice/);
    expect(() => plan({ ROLES: 'keeper' })).toThrow(/KEEPER_PRIVATE_KEY is required/);
  });
});
