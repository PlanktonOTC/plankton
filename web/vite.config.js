import { defineConfig, loadEnv } from 'vite';

// The site talks to the PlanktonOTC API. In development '/api' is forwarded to the local API (default port 8787, see
// docs/local-fork.md) so the browser sees one origin and needs no CORS setup. A production build reads VITE_API_URL instead.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
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
