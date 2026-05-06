import { defineConfig } from 'drizzle-kit';
import { dbConfig } from './bin/db-config.js';

export default defineConfig({
	dialect: 'turso',
	schema: 'src/lib/server/schema.ts',
	out: 'drizzle',
	dbCredentials: dbConfig,
});
