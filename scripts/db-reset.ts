// Empties the working tables. For a THROWAWAY test database only: each new local fork is a new chain, so rows from
// an earlier fork would be wrong. Refuses to run unless FORK_DB_RESET=yes is set, so it cannot wipe a real database by accident.
import { createDb, sql } from '@plankton/db';

if (process.env.FORK_DB_RESET !== 'yes') {
  console.error('refusing: set FORK_DB_RESET=yes to confirm this is a throwaway database');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const { db, close } = createDb(url, { max: 1 });
await db.execute(sql`truncate table positions, trades, orders, leases, indexer_cursor`);
await close();
console.log('test database emptied');
