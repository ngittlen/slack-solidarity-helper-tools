// Apply pending Drizzle migrations against TURSO_DATABASE_URL.
// Invoked by Fly's release_command on every deploy (see fly.toml). Plain JS so
// it runs against the pruned production node_modules — no tsx / drizzle-kit
// required at runtime.

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { dbConfig } from './db-config.js';

const db = drizzle(createClient(dbConfig));

console.log('[migrate] applying pending migrations...');
await migrate(db, { migrationsFolder: 'drizzle' });
console.log('[migrate] done');
