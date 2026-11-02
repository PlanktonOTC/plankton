import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors/injected';
import { defineChain } from 'viem';
import { CHAIN_ID, EXPLORER_URL, RPC_URL } from './env.js';

/** Robinhood Chain. The same definition is what a wallet is offered when it has to add the network. */
export const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER_URL } },
});

// Browser wallets announce themselves (EIP-6963), so MetaMask, Rabby, Coinbase Wallet and others each appear as their own
// choice without bundling any of their SDKs. `injected()` is the fallback for a wallet that does not announce itself.
export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: { [chain.id]: http(RPC_URL) },
  multiInjectedProviderDiscovery: true,
});

export const explorerTx = (hash) => `${EXPLORER_URL}/tx/${hash}`;
