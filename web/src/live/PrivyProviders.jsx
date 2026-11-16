import React from 'react';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { WagmiProvider, createConfig } from '@privy-io/wagmi';
import { http } from 'wagmi';
import { QueryClientProvider } from '@tanstack/react-query';
import { RPC_URL } from './env.js';
import { PrivyAuth } from './privyAuth.js';
import { chain } from './wagmi.js';

// Privy owns the connection: email, passkey and Google sign-ins get an embedded wallet (a plain EOA, so permits, order
// signatures and gasless orders work exactly as with a browser wallet), and browser wallets connect through the same modal.
const wagmiConfig = createConfig({ chains: [chain], transports: { [chain.id]: http(RPC_URL) } });

const privyConfig = {
  loginMethods: ['email', 'passkey', 'google', 'wallet'],
  defaultChain: chain,
  supportedChains: [chain],
  appearance: { theme: 'dark', walletChainType: 'ethereum-only' },
  embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
};

function Bridge({ children }) {
  const { ready, authenticated, login, logout } = usePrivy();
  return <PrivyAuth.Provider value={{ ready, authenticated, login, logout }}>{children}</PrivyAuth.Provider>;
}

export default function PrivyProviders({ appId, queryClient, children }) {
  return (
    <PrivyProvider appId={appId} config={privyConfig}>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <Bridge>{children}</Bridge>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
