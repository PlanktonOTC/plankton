import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const { db, close } = createDb(url, { max: 1 });
await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
await close();
console.log('migrations applied');
