import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

const KEY = randomBytes(32).toString('base64');

vi.mock('./env.js', () => ({ TOKEN_ENCRYPTION_KEY: KEY }));

const mockRevoke = vi.hoisted(() => vi.fn());
const mockWebClient = vi.hoisted(() => vi.fn());
vi.mock('@slack/web-api', () => ({ WebClient: mockWebClient }));

const {
	loadUserToken,
	saveUserToken,
	deleteUserToken,
	revokeUserToken,
	hasScope,
	POST_AS_USER_SCOPE,
} = await import('./user-tokens.js');
const { encryptToken } = await import('./token-crypto.js');

/** Minimal drizzle stand-in: `select().from().where()` resolves to `rows`. */
function makeDb(rows: unknown[] | Error) {
	const where = vi.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)));
	const from = vi.fn(() => ({ where }));
	const select = vi.fn(() => ({ from }));

	const onConflictDoUpdate = vi.fn(() => Promise.resolve());
	// Typed via the generic rather than a named parameter so `.mock.calls[0][0]`
	// is indexable without leaving an unused binding behind.
	const values = vi.fn<(row: unknown) => { onConflictDoUpdate: typeof onConflictDoUpdate }>(() => ({
		onConflictDoUpdate,
	}));
	const insert = vi.fn(() => ({ values }));

	const deleteWhere = vi.fn(() => Promise.resolve());
	const del = vi.fn(() => ({ where: deleteWhere }));

	return {
		db: { select, from, insert, delete: del } as never,
		spies: { select, insert, values, onConflictDoUpdate, del, deleteWhere },
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('hasScope', () => {
	it('finds a scope in a comma-separated list', () => {
		expect(hasScope('identity.basic,chat:write', 'chat:write')).toBe(true);
	});

	it('tolerates spaces around entries', () => {
		expect(hasScope('identity.basic, chat:write', 'chat:write')).toBe(true);
	});

	it('does not match a prefix of a longer scope', () => {
		expect(hasScope('chat:write.customize', 'chat:write')).toBe(false);
	});

	it('is false for an empty scope string', () => {
		expect(hasScope('', 'chat:write')).toBe(false);
	});
});

describe('loadUserToken', () => {
	it('decrypts and returns a token granted the posting scope', async () => {
		const { db } = makeDb([
			{
				encryptedToken: encryptToken('xoxp-real', KEY),
				scopes: `identity.basic,${POST_AS_USER_SCOPE}`,
			},
		]);
		await expect(loadUserToken(db, 'U1')).resolves.toEqual({ ok: true, token: 'xoxp-real' });
	});

	it('reports "missing" when there is no row', async () => {
		const { db } = makeDb([]);
		await expect(loadUserToken(db, 'U1')).resolves.toEqual({ ok: false, reason: 'missing' });
	});

	it('reports "stale-scope" for a token predating chat:write', async () => {
		// Decryptable and real, but Slack would reject the post with
		// missing_scope — a worse error to show than "authorize again".
		const { db } = makeDb([
			{ encryptedToken: encryptToken('xoxp-old', KEY), scopes: 'identity.basic' },
		]);
		await expect(loadUserToken(db, 'U1')).resolves.toEqual({ ok: false, reason: 'stale-scope' });
	});

	it('reports "unreadable" when the ciphertext does not decrypt', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const otherKey = randomBytes(32).toString('base64');
		const { db } = makeDb([
			{ encryptedToken: encryptToken('xoxp-real', otherKey), scopes: POST_AS_USER_SCOPE },
		]);
		await expect(loadUserToken(db, 'U1')).resolves.toEqual({ ok: false, reason: 'unreadable' });
	});

	it('reports "error" when the database read fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { db } = makeDb(new Error('db down'));
		await expect(loadUserToken(db, 'U1')).resolves.toEqual({ ok: false, reason: 'error' });
	});

	it('never lets a raw token reach the logs on failure', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const otherKey = randomBytes(32).toString('base64');
		const { db } = makeDb([
			{ encryptedToken: encryptToken('xoxp-supersecret', otherKey), scopes: POST_AS_USER_SCOPE },
		]);

		await loadUserToken(db, 'U1');

		const logged = errorSpy.mock.calls.flat().join(' ');
		expect(logged).not.toContain('xoxp-supersecret');
	});
});

describe('saveUserToken', () => {
	it('stores ciphertext rather than the raw token', async () => {
		const { db, spies } = makeDb([]);

		await saveUserToken(db, {
			slackUserId: 'U1',
			accessToken: 'xoxp-plaintext',
			scopes: POST_AS_USER_SCOPE,
		});

		const row = spies.values.mock.calls[0]![0] as { encryptedToken: string };
		expect(row.encryptedToken).not.toContain('xoxp-plaintext');
		expect(JSON.stringify(spies.values.mock.calls[0])).not.toContain('xoxp-plaintext');
	});

	it('upserts so re-authorizing replaces the old token', async () => {
		const { db, spies } = makeDb([]);
		await saveUserToken(db, { slackUserId: 'U1', accessToken: 'xoxp-a', scopes: 'chat:write' });
		expect(spies.onConflictDoUpdate).toHaveBeenCalledTimes(1);
	});

	it('round-trips through loadUserToken', async () => {
		const { db, spies } = makeDb([]);
		await saveUserToken(db, { slackUserId: 'U1', accessToken: 'xoxp-abc', scopes: 'chat:write' });

		const stored = spies.values.mock.calls[0]![0] as { encryptedToken: string; scopes: string };
		const { db: readDb } = makeDb([stored]);

		await expect(loadUserToken(readDb, 'U1')).resolves.toEqual({ ok: true, token: 'xoxp-abc' });
	});
});

describe('deleteUserToken', () => {
	it('issues a delete', async () => {
		const { db, spies } = makeDb([]);
		await deleteUserToken(db, 'U1');
		expect(spies.del).toHaveBeenCalledTimes(1);
		expect(spies.deleteWhere).toHaveBeenCalledTimes(1);
	});
});

describe('revokeUserToken', () => {
	beforeEach(() => {
		mockWebClient.mockImplementation(function () {
			return { auth: { revoke: mockRevoke } };
		});
	});

	it('revokes with the token it was given, and reports success', async () => {
		mockRevoke.mockResolvedValue({ ok: true, revoked: true });

		expect(await revokeUserToken('xoxp-real', 'U1')).toBe(true);
		expect(mockWebClient).toHaveBeenCalledWith('xoxp-real', expect.anything());
	});

	// The client's default is ten retries over ~30 minutes with no timeout,
	// which would hang the request someone is waiting on.
	it('makes one bounded attempt rather than the client default', async () => {
		mockRevoke.mockResolvedValue({ ok: true });

		await revokeUserToken('xoxp-real', 'U1');
		expect(mockWebClient).toHaveBeenCalledWith(
			'xoxp-real',
			expect.objectContaining({
				retryConfig: { retries: 0 },
				timeout: expect.any(Number),
				rejectRateLimitedCalls: true,
			}),
		);
	});

	it.each(['token_revoked', 'invalid_auth', 'account_inactive'])(
		'counts a token Slack says is already dead (%s) as revoked',
		async (code) => {
			mockRevoke.mockRejectedValue(new Error(`An API error occurred: ${code}`));

			expect(await revokeUserToken('xoxp-dead', 'U1')).toBe(true);
		},
	);

	it('reports failure rather than throwing', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockRevoke.mockRejectedValue(new Error('An API error occurred: ratelimited'));

		expect(await revokeUserToken('xoxp-live', 'U1')).toBe(false);
	});

	it('never logs the token', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockRevoke.mockRejectedValue(new Error('nope'));

		await revokeUserToken('xoxp-supersecret', 'U1');
		expect(JSON.stringify(warn.mock.calls)).not.toContain('xoxp-supersecret');
	});
});
