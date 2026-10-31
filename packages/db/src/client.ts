import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof createDb>['db'];

/**
 * Hosted Postgres (Neon/Supabase). Put `?sslmode=require` in the URL.
 * Tests refuse any database whose name does not end in `_test`.
 */
export function createDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, { max: opts.max ?? 10, idle_timeout: 20, prepare: false });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) throw new Error(`refusing to run tests against database "${name}": name must end in _test`);
}
