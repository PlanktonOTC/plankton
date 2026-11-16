import React, { Suspense, lazy } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PRIVY_APP_ID } from './env.js';
import { wagmiConfig } from './wagmi.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2_000, refetchOnWindowFocus: true },
  },
});

// The Privy SDK is large: it is only fetched when an app id is configured.
const PrivyProviders = PRIVY_APP_ID ? lazy(() => import('./PrivyProviders.jsx')) : null;

/** Wallet and data providers for the trading terminal. Loaded only with the /trade page. */
export default function Providers({ children }) {
  if (PrivyProviders) {
    return <Suspense fallback={null}><PrivyProviders appId={PRIVY_APP_ID} queryClient={queryClient}>{children}</PrivyProviders></Suspense>;
  }
  return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></WagmiProvider>;
}
