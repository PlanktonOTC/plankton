import { describe, expect, test } from 'bun:test';
import { toFunctionSelector, type AbiFunction } from 'viem';
import { exchangeAbi, exchangeDomain, orderTypes, payoutDeskAbi, permitTypes, usdgDomain, vaultAbi } from '../src/index.ts';

// The website (web/src/live) keeps its own small copies of the contract functions and signed-message shapes it uses, so the
// site builds without the backend packages. These tests are the tie between the two: if a contract or message changes
// and the site is not updated, they fail here rather than in a trader's wallet.

const WEB = '../../../web/src/live/';
const web = (name: string) => import(`${WEB}${name}`) as Promise<Record<string, any>>;

const selectors = (abi: readonly unknown[]) => new Map((abi as AbiFunction[]).filter((i) => i.type === 'function').map((i) => [i.name, toFunctionSelector(i)]));

describe('the site calls the contracts with the signatures they really have', () => {
  const cases: Array<[string, string, readonly unknown[]]> = [
    ['exchangeAbi', 'exchange', exchangeAbi],
    ['vaultAbi', 'vault', vaultAbi],
    ['payoutDeskAbi', 'payout desk', payoutDeskAbi],
  ];
  for (const [exportName, label, backend] of cases) {
    test(`${label}: every function on the site exists on-chain with the same selector`, async () => {
      const site = selectors((await web('abis.js'))[exportName]);
      const chain = selectors(backend);
      expect(site.size).toBeGreaterThan(0);
      for (const [name, selector] of site) {
        expect(chain.has(name)).toBe(true); // otherwise the contract no longer has this function
        expect(selector).toBe(chain.get(name)!); // otherwise its signature changed
      }
    });
  }
});

describe('the site signs the messages the contracts verify', () => {
  test('Order typed data is identical', async () => {
    expect((await web('orders.js')).orderTypes).toEqual(orderTypes as never);
  });

  test('Permit typed data is identical', async () => {
    expect((await web('orders.js')).permitTypes).toEqual(permitTypes as never);
  });

  test('the exchange and USDG domains are identical', async () => {
    const orders = await web('orders.js');
    const exchange = '0x1111111111111111111111111111111111111111';
    expect(orders.exchangeDomain(4663, exchange)).toEqual(exchangeDomain(exchange) as never);
    expect(orders.usdgDomain(4663, usdgDomain.verifyingContract)).toEqual(usdgDomain as never);
  });
});
