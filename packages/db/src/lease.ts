import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { leases } from './schema.ts';

/**
 * Take or renew a named lease. Returns true when `holder` owns it afterwards.
 * Atomic: the upsert only overwrites a lease that is ours or has expired.
 */
export async function acquireLease(db: Db, name: string, holder: string, ttlSec: number): Promise<boolean> {
  const rows = await db
    .insert(leases)
    .values({ name, holder, expiresAt: sql`now() + make_interval(secs => ${ttlSec})` })
    .onConflictDoUpdate({
      target: leases.name,
      set: { holder, expiresAt: sql`now() + make_interval(secs => ${ttlSec})` },
      setWhere: or(eq(leases.holder, holder), lt(leases.expiresAt, sql`now()`)),
    })
    .returning({ holder: leases.holder });
  return rows[0]?.holder === holder;
}

export async function releaseLease(db: Db, name: string, holder: string): Promise<void> {
  await db.delete(leases).where(and(eq(leases.name, name), eq(leases.holder, holder)));
}
