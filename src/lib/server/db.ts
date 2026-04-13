import { createClient, type Client, type InStatement } from '@libsql/client';
import { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } from './env.js';

export interface SessionData {
	slackUserId: string;
	slackUserName: string;
}

// Lazily initialized — created on first call to getDb() so createClient()
// is never called at build time when env vars are absent.
let _db: Client | null = null;

export function getDb(): Client {
	if (!_db) {
		_db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
	}
	return _db;
}

// Convenience export for direct use in route handlers.
export const db = {
	execute: (stmt: InStatement) => getDb().execute(stmt),
};

// Schema init — called from hooks.server.ts init() at server startup.
export async function initDbSchema(): Promise<void> {
	const client = getDb();
	await client.execute(`
    CREATE TABLE IF NOT EXISTS requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT UNIQUE,
      name         TEXT,
      phone        TEXT,
      comment      TEXT,
      requested_at TEXT NOT NULL
    )
  `);
	// Migrations for columns added after initial schema
	const migrations = [
		`ALTER TABLE requests ADD COLUMN helped INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE requests ADD COLUMN last_edited_by_id TEXT`,
		`ALTER TABLE requests ADD COLUMN last_edited_by_name TEXT`,
		`ALTER TABLE requests ADD COLUMN status TEXT NOT NULL DEFAULT 'uncontacted'`,
	];
	for (const sql of migrations) {
		try {
			await client.execute(sql);
		} catch {
			// column already exists
		}
	}
	// Data migration: backfill status for rows that were marked helped before status column existed
	await client.execute(
		`UPDATE requests SET status = 'verified_in_slack' WHERE helped = 1 AND status = 'uncontacted'`
	);

	await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
}

// --- Session store ---

export class TursoStore {
	async get(sid: string): Promise<SessionData | null> {
		try {
			const result = await getDb().execute({
				sql: 'SELECT data, expires_at FROM sessions WHERE sid = ?',
				args: [sid],
			});
			if (result.rows.length === 0) return null;
			const row = result.rows[0]!;
			if (new Date(row['expires_at'] as string) < new Date()) {
				await this.destroy(sid);
				return null;
			}
			return JSON.parse(row['data'] as string) as SessionData;
		} catch {
			return null;
		}
	}

	async set(sid: string, data: SessionData, maxAgeSeconds: number): Promise<void> {
		const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000).toISOString();
		await getDb().execute({
			sql: 'INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)',
			args: [sid, JSON.stringify(data), expiresAt],
		});
	}

	async destroy(sid: string): Promise<void> {
		await getDb().execute({
			sql: 'DELETE FROM sessions WHERE sid = ?',
			args: [sid],
		});
	}
}

export const sessionStore = new TursoStore();