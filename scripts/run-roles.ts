// Runs several PlanktonOTC services in one host, for hosting plans that give few always-on instances (Render free).
//
//   ROLES=api,mark,signer-quote,signer-mark-1,signer-mark-2,keeper,indexer bun run scripts/run-roles.ts
//
// The first role listed gets the host's PORT; the rest find each other on 127.0.0.1, and signers that are not the public
// role listen only there (SIGNER_HOST=127.0.0.1), which production allows without mTLS. The web role serves the site
// and forwards /api to the api role on the same host. Each child gets
// only its own private key (PUBLISHER_PRIVATE_KEY, KEEPER_PRIVATE_KEY, QUOTE_SIGNER_<n>_PRIVATE_KEY or
// MARK_SIGNER_<n>_PRIVATE_KEY from this process's env); every other *_PRIVATE_KEY is stripped from its environment.
// Signers on another host join through EXTRA_MARK_SIGNER_URLS / EXTRA_QUOTE_SIGNER_URLS. A child that exits is
// restarted with backoff. MIGRATE_ON_START=true runs the database migrations first.

type Role = { name: string; entry: string; env: (ctx: Ctx) => Record<string, string> };
type Ctx = { urlOf: (role: string) => string | undefined; signerUrls: (kind: 'mark' | 'quote') => string[]; need: (key: string) => string };

const signerRole = (kind: 'mark' | 'quote', n: number): Role => ({
  name: `signer-${kind}-${n}`,
  entry: 'apps/signer/src/index.ts',
  env: (ctx) => ({ SIGNER_ROLE: kind, SIGNER_PRIVATE_KEY: ctx.need(`${kind.toUpperCase()}_SIGNER_${n}_PRIVATE_KEY`) }),
});

const ROLES: Record<string, Role> = {
  api: {
    name: 'api',
    entry: 'apps/api/src/index.ts',
    env: (ctx) => ({
      QUOTE_SIGNER_URLS: ctx.signerUrls('quote').join(','),
      ...(ctx.urlOf('mark') ? { MARK_SERVICE_URL: ctx.urlOf('mark')! } : {}),
    }),
  },
  mark: {
    name: 'mark',
    entry: 'apps/mark/src/index.ts',
    env: (ctx) => ({ MARK_SIGNER_URLS: ctx.signerUrls('mark').join(','), PUBLISHER_PRIVATE_KEY: ctx.need('PUBLISHER_PRIVATE_KEY') }),
  },
  keeper: {
    name: 'keeper',
    entry: 'apps/keeper/src/index.ts',
    env: (ctx) => ({ ...(ctx.urlOf('api') ? { API_URL: ctx.urlOf('api')! } : {}), KEEPER_PRIVATE_KEY: ctx.need('KEEPER_PRIVATE_KEY') }),
  },
  indexer: { name: 'indexer', entry: 'apps/indexer/src/index.ts', env: () => ({}) },
  web: {
    name: 'web',
    entry: 'web/server.mjs',
    env: (ctx): Record<string, string> => (ctx.urlOf('api') ? { API_ORIGIN: ctx.urlOf('api')! } : {}),
  },
};
for (const n of [1, 2, 3]) {
  ROLES[`signer-mark-${n}`] = signerRole('mark', n);
  ROLES[`signer-quote-${n}`] = signerRole('quote', n);
}
ROLES['signer-quote'] = { ...ROLES['signer-quote-1']!, name: 'signer-quote' };

const list = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export function plan(env: Record<string, string | undefined>) {
  const names = list(env.ROLES);
  if (names.length === 0) throw new Error('ROLES is empty: list the services to run, e.g. ROLES=api,mark,keeper');
  for (const n of names) if (!ROLES[n]) throw new Error(`unknown role ${n}; known: ${Object.keys(ROLES).join(', ')}`);
  if (new Set(names).size !== names.length) throw new Error('ROLES lists a service twice');

  const publicPort = Number(env.PORT) || 10000;
  const internalBase = Number(env.INTERNAL_PORT_BASE) || 18100;
  const ports = new Map(names.map((n, i) => [n, i === 0 ? publicPort : internalBase + i]));
  const urlOf = (role: string) => (ports.has(role) ? `http://127.0.0.1:${ports.get(role)}` : undefined);
  const signerUrls = (kind: 'mark' | 'quote') => [
    ...names.filter((n) => n.startsWith(`signer-${kind}`)).map((n) => urlOf(n)!),
    ...list(kind === 'mark' ? env.EXTRA_MARK_SIGNER_URLS : env.EXTRA_QUOTE_SIGNER_URLS),
  ];
  const need = (key: string) => {
    const v = env[key];
    if (!v) throw new Error(`${key} is required for the roles in ROLES`);
    return v;
  };
  const ctx: Ctx = { urlOf, signerUrls, need };

  const base = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !k.endsWith('_PRIVATE_KEY'))) as Record<string, string>;
  return names.map((n) => {
    const role = ROLES[n]!;
    const childEnv: Record<string, string> = { ...base, ...role.env(ctx), PORT: String(ports.get(n)) };
    if (n.startsWith('signer-') && ports.get(n) !== publicPort) childEnv.SIGNER_HOST = '127.0.0.1';
    return { name: n, entry: role.entry, port: ports.get(n)!, env: childEnv };
  });
}

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream) {
  const decoder = new TextDecoder();
  let carry = '';
  for await (const chunk of stream) {
    const lines = (carry + decoder.decode(chunk, { stream: true })).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) out.write(`[${prefix}] ${line}\n`);
  }
  if (carry) out.write(`[${prefix}] ${carry}\n`);
}

async function main() {
  const children = plan(process.env);
  let stopping = false;
  const running = new Map<string, ReturnType<typeof Bun.spawn>>();

  if (process.env.MIGRATE_ON_START === 'true') {
    const m = Bun.spawn(['bun', 'run', 'packages/db/src/migrate.ts'], { stdout: 'inherit', stderr: 'inherit' });
    if ((await m.exited) !== 0) {
      console.error('[run-roles] database migration failed');
      process.exit(1);
    }
  }

  const start = (c: (typeof children)[number], delayMs = 1000) => {
    const startedAt = Date.now();
    const proc = Bun.spawn(['bun', '--smol', 'run', c.entry], { env: c.env, stdout: 'pipe', stderr: 'pipe' });
    running.set(c.name, proc);
    void pipe(proc.stdout as ReadableStream<Uint8Array>, c.name, process.stdout);
    void pipe(proc.stderr as ReadableStream<Uint8Array>, c.name, process.stderr);
    void proc.exited.then((code) => {
      if (stopping) return;
      // Back off while it keeps crashing; a run that lasted a minute starts the backoff over.
      const next = Date.now() - startedAt > 60_000 ? 1000 : Math.min(delayMs * 2, 30_000);
      console.error(`[run-roles] ${c.name} exited with ${code}; restarting in ${next / 1000}s`);
      setTimeout(() => !stopping && start(c, next), next);
    });
  };

  for (const c of children) {
    console.log(`[run-roles] starting ${c.name} on port ${c.port}`);
    start(c);
  }

  const stop = () => {
    stopping = true;
    for (const p of running.values()) p.kill('SIGTERM');
    setTimeout(() => process.exit(0), 5_000).unref();
    void Promise.all([...running.values()].map((p) => p.exited)).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.main) await main();
