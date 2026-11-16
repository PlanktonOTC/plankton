import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

// Privy bundles Coinbase's SDK, whose Solana helpers want @solana/kit 8 but resolve the SDK's own kit 5, which lacks this
// entry. The site never runs Solana code; pointing the one missing entry at the kit 8 this package depends on lets it build.
const kitDist = path.dirname(createRequire(import.meta.url).resolve('@solana/kit'));

// The site talks to the PlanktonOTC API. In development '/api' is forwarded to the local API (default port 8787, see
// docs/local-fork.md) so the browser sees one origin and needs no CORS setup. In production web/server.mjs does the same.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    resolve: {
      alias: { '@solana/kit/program-client-core': path.join(kitDist, 'program-client-core.browser.mjs') },
    },
    server: {
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY || 'http://127.0.0.1:8787',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
