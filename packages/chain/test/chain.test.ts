import { describe, expect, test } from 'bun:test';
import { recoverTypedDataAddress, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  attestationTypes,
  attestationWire,
  exchangeDomain,
  markDomain,
  marketIdFor,
  orderWire,
  permitTypedData,
  quoteTypes,
  quoteWire,
  readChainlink,
  toJson,
  wire,
  type ChainClient,
  type TradeQuoteMsg,
} from '../src/index.ts';

describe('market ids', () => {
  test('are salted and match the id the contracts computed on the fork', () => {
    // Computed independently by the Solidity script (keccak256(abi.encode("plankton.mkt.v1", symbol, token))).
    expect(marketIdFor('AAPL', '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')).toBe(
      '0xa7ee273e3bde6fba91b0c7362bbcc83dc8fb25d278bacd6fb16d715fe2965178',
    );
  });
  test('depend on both the symbol and the token', () => {
    const a = marketIdFor('AAPL', '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9');
    expect(marketIdFor('AAPL', '0x0000000000000000000000000000000000000001')).not.toBe(a);
    expect(marketIdFor('MSFT', '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')).not.toBe(a);
  });
});

describe('wire formats', () => {
  const quote: TradeQuoteMsg = {
    marketId: '0xa7ee273e3bde6fba91b0c7362bbcc83dc8fb25d278bacd6fb16d715fe2965178',
    trader: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
    sizeDeltaE18: -500_000_000_000_000_000n,
    execPriceE18: 350_307_600_000_000_000_000n,
    feeUsdg: 140_123n,
    maxLeverageE18: 2_000_000_000_000_000_000n,
    markSequence: 33n,
    nonce: 18_446_744_073_709_551_615n,
    expiry: 1_793_602_992n,
  };

  test('a quote survives JSON, including negative sizes and 64-bit nonces', () => {
    const back = quoteWire.parse(JSON.parse(toJson(wire(quote))));
    expect(back).toEqual(quote);
  });

  test('numbers must travel as strings of digits', () => {
    expect(quoteWire.safeParse({ ...wire(quote), feeUsdg: 1.5 }).success).toBe(false);
    expect(quoteWire.safeParse({ ...wire(quote), nonce: '12abc' }).success).toBe(false);
    expect(quoteWire.safeParse({ ...wire(quote), trader: '0x123' }).success).toBe(false);
  });

  test('an order checks its small fields', () => {
    const order = { marketId: quote.marketId, trader: quote.trader, kind: 3, sizeDeltaE18: '0', sizeBps: 10_000, triggerE18: '95000000000000000000', triggerAbove: false, reduceOnly: true, maxSlippageBps: 300, marginUsdg: '0', validAfter: '1', expiry: '2', nonce: '1' };
    expect(orderWire.safeParse(order).success).toBe(true);
    expect(orderWire.safeParse({ ...order, kind: 9 }).success).toBe(false);
    expect(orderWire.safeParse({ ...order, sizeBps: 10_001 }).success).toBe(false);
  });

  test('an attestation cannot carry the Unset status', () => {
    const a = { marketId: quote.marketId, markE18: '1', refCloseE18: '1', confidenceBps: 10, status: 0, sequence: '1', observedAt: '1', expiry: '2' };
    expect(attestationWire.safeParse(a).success).toBe(false);
    expect(attestationWire.safeParse({ ...a, status: 3 }).success).toBe(true);
  });
});

describe('signatures', () => {
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const account = privateKeyToAccount(key);
  const exchange = '0x9301981F27950e6546033EADD046C86754263f2D';
  const message: TradeQuoteMsg = {
    marketId: '0xa7ee273e3bde6fba91b0c7362bbcc83dc8fb25d278bacd6fb16d715fe2965178',
    trader: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
    sizeDeltaE18: 1n,
    execPriceE18: 2n,
    feeUsdg: 3n,
    maxLeverageE18: 4n,
    markSequence: 5n,
    nonce: 6n,
    expiry: 7n,
  };

  test('a signed quote verifies against the Exchange domain only', async () => {
    const signature = await account.signTypedData({ domain: exchangeDomain(exchange), types: quoteTypes, primaryType: 'TradeQuote', message });
    expect(await recoverTypedDataAddress({ domain: exchangeDomain(exchange), types: quoteTypes, primaryType: 'TradeQuote', message, signature })).toBe(account.address);
    // The same signature is worthless on another deployment or against a changed quote.
    expect(await verifyTypedData({ address: account.address, domain: exchangeDomain('0x0000000000000000000000000000000000000001'), types: quoteTypes, primaryType: 'TradeQuote', message, signature })).toBe(false);
    expect(await verifyTypedData({ address: account.address, domain: exchangeDomain(exchange), types: quoteTypes, primaryType: 'TradeQuote', message: { ...message, feeUsdg: 0n }, signature })).toBe(false);
  });

  test('exchange and oracle domains differ, so a mark signature cannot be replayed as a quote', () => {
    expect(exchangeDomain(exchange).name).toBe('PlanktonExchange');
    expect(markDomain(exchange).name).toBe('PlanktonMark');
    expect(attestationTypes.Attestation.map((f) => f.name)).toEqual(['marketId', 'markE18', 'refCloseE18', 'confidenceBps', 'status', 'sequence', 'observedAt', 'expiry']);
  });

  test('the USDG permit uses the hardcoded Global Dollar domain on chain 4663', () => {
    const p = permitTypedData(account.address, exchange, 100n, 0n, 999n);
    expect(p.domain).toMatchObject({ name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' });
    expect(p.primaryType).toBe('Permit');
  });
});

describe('Chainlink reader', () => {
  /** A stand-in client answering the two multicalls readChainlink makes. */
  const fakeClient = (rounds: Array<{ answer: bigint; updatedAt: bigint } | 'fail'>, decimals = 8): ChainClient =>
    ({
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
        if (contracts[0]!.functionName === 'decimals') return contracts.map(() => ({ status: 'success', result: decimals }));
        return rounds.map((r) => (r === 'fail' ? { status: 'failure', error: new Error('reverted') } : { status: 'success', result: [1n, r.answer, 0n, r.updatedAt, 1n] }));
      },
    }) as unknown as ChainClient;

  test('scales an 8-decimal answer to E18 and converts the update time to milliseconds', async () => {
    const out = await readChainlink(fakeClient([{ answer: 34_490_763_487n, updatedAt: 1_793_000_000n }]), [{ symbol: 'AAPL', feed: '0x00000000000000000000000000000000000000a1' }], 5);
    const o = out.get('AAPL')!;
    expect(o.source).toBe('chainlink');
    expect(o.priceE18).toBe(344_907_634_870_000_000_000n);
    expect(o.sourceUpdatedAt).toBe(1_793_000_000_000);
    expect(o.observedAt).toBe(5);
  });

  test('a failed read or a non-positive answer gives no observation instead of a bad price', async () => {
    const out = await readChainlink(
      fakeClient([{ answer: 0n, updatedAt: 1n }, { answer: -5n, updatedAt: 1n }, 'fail']),
      [
        { symbol: 'ZERO', feed: '0x00000000000000000000000000000000000000b1' },
        { symbol: 'NEG', feed: '0x00000000000000000000000000000000000000b2' },
        { symbol: 'DEAD', feed: '0x00000000000000000000000000000000000000b3' },
      ],
    );
    expect(out.get('ZERO')).toBeNull();
    expect(out.get('NEG')).toBeNull();
    expect(out.get('DEAD')).toBeNull();
  });

  test('handles a feed with more than 18 decimals', async () => {
    const out = await readChainlink(fakeClient([{ answer: 123_456_789_012_345_678_901_234n, updatedAt: 1n }], 20), [{ symbol: 'X', feed: '0x00000000000000000000000000000000000000c1' }]);
    expect(out.get('X')!.priceE18).toBe(1_234_567_890_123_456_789_012n);
  });
});
