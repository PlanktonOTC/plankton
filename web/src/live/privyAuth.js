import { createContext, useContext } from 'react';

/**
 * Privy's sign-in actions, provided only when Privy is configured (VITE_PRIVY_APP_ID). Kept apart from PrivyProviders.jsx
 * so the wallet hook can read it without loading the Privy SDK when the site runs without it.
 */
export const PrivyAuth = createContext(null);
export const usePrivyAuth = () => useContext(PrivyAuth);
