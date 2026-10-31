import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { migrate } from 'drizzle-orm/libsql/migrator';

// The real session store on a real in-memory libsql, built from the real
// migrations — the point of these tests is the SQL `update` sends.
vi.mock('./env.js', () => ({ TURSO_DATABASE_URL: ':memory:', TURSO_AUTH_TOKEN: undefined }));
vi.mock('$app/environment', () => ({ dev: true }));

import { db, sessionStore, type SessionData } from './db.js';
import { startSession, updateSession } from './session.js';

const UNNAMED: SessionData = {
	slackUserId: 'apple:001.abc',
	slackUserName: '',
	isAdmin: false,
	authProvider: 'apple',
	needsName: true,
};
const NAMED: SessionData = { ...UNNAMED, slackUserName: 'Bo', needsName: undefined };

function cookies(sid: string | undefined) {
	return { get: (name: string) => (name === 'session' ? sid : undefined) } as never;
}

async function rows(sid: string) {
	return db.$client.execute({
		sql: 'SELECT data, expires_at FROM sessions WHERE sid = ?',
		args: [sid],
	});
}

beforeAll(async () => {
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await db.$client.execute('DELETE FROM sessions');
});

describe('sessionStore.update', () => {
	it('rewrites a live session and keeps its expiry', async () => {
		await sessionStore.set('s1', UNNAMED, 3600);
		const before = (await rows('s1')).rows[0]!.expires_at;

		expect(await sessionStore.update('s1', NAMED)).toBe(true);

		const lookup = await sessionStore.get('s1');
		expect(lookup).toMatchObject({ status: 'found', data: { slackUserName: 'Bo' } });
		expect(lookup.status === 'found' && lookup.data.needsName).toBeUndefined();
		expect((await rows('s1')).rows[0]!.expires_at).toBe(before);
	});

	// The race the upsert in `set` lost: a block or sign-out deleted the row
	// between reading the session and writing it back.
	it('never brings back a session that was deleted meanwhile', async () => {
		await sessionStore.set('s1', UNNAMED, 3600);
		await sessionStore.destroy('s1');

		expect(await sessionStore.update('s1', NAMED)).toBe(false);
		expect((await rows('s1')).rows).toHaveLength(0);
	});

	it('does not touch an expired session', async () => {
		await sessionStore.set('s1', UNNAMED, 3600);
		await db.$client.execute({
			sql: 'UPDATE sessions SET expires_at = ? WHERE sid = ?',
			args: [new Date(Date.now() - 1000).toISOString(), 's1'],
		});

		expect(await sessionStore.update('s1', NAMED)).toBe(false);
		expect(JSON.parse(String((await rows('s1')).rows[0]!.data))).toMatchObject({
			slackUserName: '',
		});
	});

	it('leaves other sessions alone', async () => {
		await sessionStore.set('s1', UNNAMED, 3600);
		await sessionStore.set('s2', UNNAMED, 3600);
		await sessionStore.update('s1', NAMED);
		const other = await sessionStore.get('s2');
		expect(other.status === 'found' && other.data.slackUserName).toBe('');
	});
});

describe('updateSession', () => {
	it('rewrites the session named by the cookie', async () => {
		await sessionStore.set('s1', UNNAMED, 3600);
		expect(await updateSession(cookies('s1'), NAMED)).toBe(true);
		const lookup = await sessionStore.get('s1');
		expect(lookup.status === 'found' && lookup.data.slackUserName).toBe('Bo');
	});

	it('is false without a cookie, or for a session that is gone', async () => {
		expect(await updateSession(cookies(undefined), NAMED)).toBe(false);
		expect(await updateSession(cookies('nobody'), NAMED)).toBe(false);
		expect((await rows('nobody')).rows).toHaveLength(0);
	});
});

describe('startSession', () => {
	function jar() {
		return { set: vi.fn() };
	}

	// What /signin marks "Last used" — outlives the 8-hour session on purpose.
	it('remembers which way the browser signed in, for a year', async () => {
		for (const [data, method] of [
			[{ slackUserId: 'U1', slackUserName: 'Dana', isAdmin: false }, 'slack'],
			[{ ...NAMED, authProvider: 'google' as const }, 'google'],
			[NAMED, 'apple'],
		] as const) {
			const cookies = jar();
			await startSession(cookies as never, data);
			expect(cookies.set).toHaveBeenCalledWith(
				'last_signin',
				method,
				expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 }),
			);
		}
	});
});
