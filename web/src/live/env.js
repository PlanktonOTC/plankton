// Build-time settings for the trading site. Set them in web/.env.local (see web/.env.example); the defaults are for
// running against the local fork described in docs/local-fork.md.
const raw = (typeof import.meta !== 'undefined' && import.meta.env) || {};

/** Where the PlanktonOTC API lives. '/api' is proxied to the local API by the dev server (see vite.config.js). */
export const API_URL = String(raw.VITE_API_URL ?? '/api').replace(/\/$/, '');
export const CHAIN_ID = Number(raw.VITE_CHAIN_ID ?? 4663);
/** Used for reading the chain from the browser (receipts) and when a wallet is asked to add the network. */
export const RPC_URL = String(raw.VITE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
export const EXPLORER_URL = String(raw.VITE_EXPLORER_URL ?? 'https://robinhoodchain.blockscout.com').replace(/\/$/, '');
