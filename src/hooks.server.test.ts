import { describe, it, expect, vi, beforeEach } from 'vitest';

// The wiring of the turf-only gate into `handle`. The rule itself is
// tested route by route in $lib/server/turf-only-access.test.ts; this checks the
// part that file cannot see — that handle hands it the real request facts
// (route id, data request, method, Accept) and acts on the answer before any
// route runs.

const mockSessionGet = vi.hoisted(() => vi.fn());

vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db.js', () => ({ db: {}, sessionStore: { get: mockSessionGet } }));
vi.mock('$lib/server/theme.js', () => ({ getTheme: async () => ({ css: '' }) }));
vi.mock('$lib/server/env.js', () => ({ INTERNAL_CRON_SECRET: '', validateEnv: () => {} }));
vi.mock('$lib/server/scheduler.js', () => ({ localCaller: vi.fn(), startScheduler: vi.fn() }));

import { handle } from './hooks.server.js';

const GOOGLE = {
	slackUserId: 'google:1093',
	slackUserName: 'Ana',
	isAdmin: false,
	isModerator: false,
	authProvider: 'google',
};
const APPLE = { ...GOOGLE, slackUserId: 'apple:000123.abc', authProvider: 'apple' };
const SLACK = { slackUserId: 'U1', slackUserName: 'Dana', isAdmin: false };

function call(opts: {
	session: unknown;
	routeId: string | null;
	path: string;
	method?: string;
	accept?: string;
	isDataRequest?: boolean;
}) {
	const url = new URL(`https://app.example${opts.path}`);
	mockSessionGet.mockResolvedValue(
		opts.session
			? {
					status: 'found',
					data: opts.session,
					expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				}
			: { status: 'missing' },
	);
	const resolve = vi.fn(async () => new Response('page'));
	const event = {
		url,
		request: new Request(url, {
			method: opts.method ?? 'GET',
			headers: { accept: opts.accept ?? 'text/html', 'content-type': 'application/json' },
			body: opts.method && opts.method !== 'GET' ? '{}' : undefined,
		}),
		route: { id: opts.routeId },
		isDataRequest: opts.isDataRequest ?? false,
		isRemoteRequest: false,
		cookies: { get: () => 'sid', set: vi.fn(), delete: vi.fn() },
		locals: {} as App.Locals,
	};
	return { result: handle({ event, resolve } as never), resolve };
}

describe('handle: the turf-only gate', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sends a Google session away from a Slack-only page before it runs', async () => {
		const { result, resolve } = call({ session: GOOGLE, routeId: '/settings', path: '/settings' });
		await expect(result).rejects.toMatchObject({
			status: 302,
			location: '/turfs?needsSlack=%2Fsettings',
		});
		expect(resolve).not.toHaveBeenCalled();
	});

	it('redirects a client-side navigation (a data request) too', async () => {
		const { result, resolve } = call({
			session: GOOGLE,
			routeId: '/',
			path: '/',
			accept: '*/*',
			isDataRequest: true,
		});
		await expect(result).rejects.toMatchObject({ status: 302 });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('answers an API call with a 403 that carries the security headers', async () => {
		const { result, resolve } = call({
			session: GOOGLE,
			routeId: '/api/pending',
			path: '/api/pending',
			method: 'POST',
			accept: 'application/json',
		});
		const response = await result;
		expect(response.status).toBe(403);
		expect(response.headers.get('X-Frame-Options')).toBe('DENY');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('lets a Google session through to turf checkout', async () => {
		const { result, resolve } = call({ session: GOOGLE, routeId: '/turfs', path: '/turfs' });
		expect((await result).status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('gates an Apple session exactly as it gates a Google one', async () => {
		const away = call({ session: APPLE, routeId: '/settings', path: '/settings' });
		await expect(away.result).rejects.toMatchObject({
			status: 302,
			location: '/turfs?needsSlack=%2Fsettings',
		});
		expect(away.resolve).not.toHaveBeenCalled();

		const through = call({ session: APPLE, routeId: '/turfs', path: '/turfs' });
		expect((await through.result).status).toBe(200);
	});

	it('leaves Slack sessions and signed-out visitors to the routes', async () => {
		for (const session of [SLACK, null]) {
			const { result, resolve } = call({ session, routeId: '/settings', path: '/settings' });
			expect((await result).status).toBe(200);
			expect(resolve).toHaveBeenCalledTimes(1);
		}
	});
});
