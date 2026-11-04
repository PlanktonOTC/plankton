import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().optional(),
  RPC_URLS: z.string().default('https://rpc.mainnet.chain.robinhood.com'),
  RH_API_BASE: z.string().default('https://api.robinhood.com/rhj'),
  NASDAQ_HALTS_URL: z.string().default('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts'),
  STOCK_TOKEN_WINDOW_TZ: z.string().default('Europe/Berlin'),
  /** enforce: a market failing the listing rule stops taking new positions. warn: only report it. off: ignore. Default: enforce in production, warn otherwise. */
  ELIGIBILITY_MODE: z.enum(['enforce', 'warn', 'off']).optional(),
  // Signer service: one process per key, role decides which endpoint it serves.
  SIGNER_ROLE: z.enum(['quote', 'mark']).optional(),
  SIGNER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  SIGNER_AUTH_TOKEN: z.string().min(16).optional(),
  SIGNER_PORT: z.coerce.number().default(8790),
  /** Interface the signer listens on. 127.0.0.1 keeps it private to its host, the only case production allows without mTLS. */
  SIGNER_HOST: z.string().optional(),
  /** Per-key notional limits (USDG, 6 decimals) so a stolen quote key can only sign so much. */
  SIGNER_MAX_NOTIONAL_PER_MIN_USDG: z.coerce.bigint().default(500_000_000_000n),
  SIGNER_MAX_NOTIONAL_PER_DAY_USDG: z.coerce.bigint().default(10_000_000_000_000n),
  /** Hard cap on how far a mark may sit from this signer's own Chainlink read before it refuses to sign. */
  SIGNER_MARK_MAX_DEV_BPS: z.coerce.number().default(1_000),
  /** Market with no Chainlink feed: how far an Open/Extended mark may sit from this signer's own Robinhood read. */
  SIGNER_SINGLE_SOURCE_MAX_DEV_BPS: z.coerce.number().default(200),
  SIGNER_TLS_CERT: z.string().optional(),
  SIGNER_TLS_KEY: z.string().optional(),
  SIGNER_TLS_CA: z.string().optional(),
  /** Comma-separated base URLs of the signer services the API / publisher call. */
  QUOTE_SIGNER_URLS: z.string().optional(),
  MARK_SIGNER_URLS: z.string().optional(),
  PUBLISHER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  KEEPER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  API_URL: z.string().default('http://127.0.0.1:8787'),
  KEEPER_PORT: z.coerce.number().default(8791),
  MARK_PORT: z.coerce.number().default(8788),
  MARK_SERVICE_URL: z.string().default('http://127.0.0.1:8788'),
  /** Set by hosts such as Render to say which port to listen on. When present it wins over the service-specific port below. */
  PORT: z.coerce.number().int().positive().optional(),
  API_PORT: z.coerce.number().default(8787),
  /** Comma-separated browser origins allowed to call the API (for example https://app.example.com). Empty: none in production, any in development. */
  CORS_ORIGINS: z.string().optional(),
  /** Requests per minute one client address may make to the API. Quote and order routes get a third of this. */
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(240),
  /** Set to true only behind a trusted proxy (Railway, a load balancer) that sets x-real-ip / x-forwarded-for. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  /** Lets the keeper's own calls skip the rate limit. Send it as the x-internal-token header. */
  INTERNAL_API_TOKEN: z.string().min(16).optional(),
  /** Shared with the website's server (web/server.mjs), which forwards each visitor's address in x-visitor-ip. */
  WEB_PROXY_TOKEN: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = Omit<z.infer<typeof schema>, 'RPC_URLS'> & { RPC_URLS: string[] };

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // A blank `NAME=` line in .env means "not set", not an empty value.
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ELIGIBILITY_MODE && parsed.data.ELIGIBILITY_MODE !== 'enforce') {
    throw new Error('invalid environment: ELIGIBILITY_MODE must be enforce (or unset) in production');
  }
  const rpcUrls = parsed.data.RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean);
  if (rpcUrls.length === 0) throw new Error('invalid environment: RPC_URLS is empty');
  return { ...parsed.data, RPC_URLS: rpcUrls };
}

export const eligibilityMode = (env: Env): 'enforce' | 'warn' | 'off' => env.ELIGIBILITY_MODE ?? (env.NODE_ENV === 'production' ? 'enforce' : 'warn');

/** Read a required setting, failing with the variable's name instead of a vague crash later. */
export function need<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') throw new Error(`${name} is required for this service`);
  return value;
}

export const urlList = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export function requireDatabaseUrl(env: Env): string {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for this service');
  return env.DATABASE_URL;
}
