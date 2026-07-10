import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOpenfieldClient, type OpenfieldClient } from './openfield.js';

// A tiny fake of Openfield's Django app: form login at /, code entry at
// /codes/, JSON leaderboard at /endpoint/<id>/today. Sessions and CSRF are
// modeled just enough to prove the client drives the real flow.
const BASE = 'https://campaign.openfield.ai';
const LOGIN_PAGE = '<form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="tok-login"></form>';
const CODES_PAGE = '<form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="tok-codes"><input name="code" maxlength="6"/></form>';

interface FakeServer {
	fetchFn: typeof fetch;
	loginPosts: () => number;
	expireSession: () => void;
}

function makeServer(opts: { password?: string } = {}): FakeServer {
	const password = opts.password ?? 'pw';
	let sessionCounter = 0;
	let validSession: string | null = null;
	let loginPosts = 0;

	function res(
		status: number,
		body: string,
		headers: Array<[string, string]> = [],
	): Response {
		const h = new Headers();
		for (const [k, v] of headers) h.append(k, v);
		return {
			status,
			headers: h,
			text: async () => body,
			json: async () => JSON.parse(body),
		} as unknown as Response;
	}

	function sessionOf(init?: RequestInit): string | null {
		const cookie = new Headers(init?.headers).get('cookie') ?? '';
		return /sessionid=([^;]+)/.exec(cookie)?.[1] ?? null;
	}

	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const path = url.slice(BASE.length);
		const method = init?.method ?? 'GET';
		const authed = sessionOf(init) !== null && sessionOf(init) === validSession;

		if (path === '/' && method === 'GET') {
			return res(200, LOGIN_PAGE, [['set-cookie', 'csrftoken=csrf-cookie; Path=/']]);
		}
		if (path === '/' && method === 'POST') {
			loginPosts++;
			const body = String(init?.body ?? '');
			if (!body.includes('csrfmiddlewaretoken=tok-login')) return res(403, 'CSRF failed');
			if (!body.includes(`password=${password}`)) return res(200, LOGIN_PAGE);
			validSession = `sess-${++sessionCounter}`;
			return res(302, '', [
				['location', `${BASE}/codes/`],
				['set-cookie', `sessionid=${validSession}; Path=/; HttpOnly`],
			]);
		}
		if (!authed) {
			return res(302, '', [['location', `${BASE}/?next=${encodeURIComponent(path)}`]]);
		}
		if (path === '/codes/' && method === 'GET') {
			return res(200, CODES_PAGE);
		}
		if (path === '/codes/' && method === 'POST') {
			const body = String(init?.body ?? '');
			if (!body.includes('csrfmiddlewaretoken=tok-codes')) return res(403, 'CSRF failed');
			if (body.includes('code=AB12CD')) {
				// Street-canvass conversations redirect under /street/.
				return res(302, '', [['location', `${BASE}/street/133/`]]);
			}
			if (body.includes('code=DK34EF')) {
				// Door-knocking conversations redirect to the bare id path.
				return res(302, '', [['location', '/1230/']]);
			}
			return res(404, 'Whoops! - 404 Error'); // unknown/retired code
		}
		// Trailing slash required — Django 301s the slashless form.
		if (/^\/endpoint\/(133|1230)\/today[^/]/.test(path)) {
			return res(301, '', [['location', path.replace('/today', '/today/')]]);
		}
		if (/^\/endpoint\/1230\/today\//.test(path)) {
			return res(200, '[]');
		}
		if (/^\/endpoint\/133\/today\//.test(path)) {
			return res(
				200,
				JSON.stringify([
					{ canvasser: 'Jane', attempts: 33, contact: 10, contact_rate: '30.30%', rank: 1 },
					{ canvasser: 'Turner', attempts: 27, contact: 10, contact_rate: '37.04%', rank: 2 },
				]),
			);
		}
		if (/^\/endpoint\/134\/today\//.test(path)) {
			return res(200, '[]');
		}
		return res(404, 'not found');
	}) as typeof fetch;

	return {
		fetchFn,
		loginPosts: () => loginPosts,
		expireSession: () => {
			validSession = null;
		},
	};
}

function makeClient(server: FakeServer, password = 'pw'): OpenfieldClient {
	return createOpenfieldClient(
		{ baseUrl: BASE, username: 'bot', password },
		server.fetchFn,
	);
}

describe('createOpenfieldClient', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('logs in, resolves a street code from the /street/<id>/ redirect', async () => {
		const server = makeServer();
		const client = makeClient(server);
		expect(await client.resolveCode('AB12CD')).toBe(133);
		expect(server.loginPosts()).toBe(1);
	});

	it('resolves a door-knock code from the bare /<id>/ redirect', async () => {
		const server = makeServer();
		const client = makeClient(server);
		expect(await client.resolveCode('DK34EF')).toBe(1230);
	});

	it('returns null for a code Openfield does not recognize (404)', async () => {
		const server = makeServer();
		const client = makeClient(server);
		expect(await client.resolveCode('ZZ99ZZ')).toBeNull();
	});

	it('fetches and maps the today leaderboard, reusing one session across calls', async () => {
		const server = makeServer();
		const client = makeClient(server);
		const rows = await client.fetchToday(133);
		expect(rows).toEqual([
			{ canvasser: 'Jane', attempts: 33, contact: 10 },
			{ canvasser: 'Turner', attempts: 27, contact: 10 },
		]);
		expect(await client.fetchToday(134)).toEqual([]);
		expect(server.loginPosts()).toBe(1);
	});

	it('re-logs in once and retries when the session expires mid-run', async () => {
		const server = makeServer();
		const client = makeClient(server);
		await client.fetchToday(133);
		server.expireSession();
		const rows = await client.fetchToday(133);
		expect(rows).toHaveLength(2);
		expect(server.loginPosts()).toBe(2);
	});

	it('re-logs in when the session expires before a form POST (code resolution)', async () => {
		const server = makeServer();
		const client = makeClient(server);
		await client.fetchToday(133);
		server.expireSession();
		expect(await client.resolveCode('AB12CD')).toBe(133);
		expect(server.loginPosts()).toBe(2);
	});

	it('throws a clear error on bad credentials', async () => {
		const server = makeServer();
		const client = makeClient(server, 'wrong-password');
		await expect(client.fetchToday(133)).rejects.toThrow(/login failed/);
	});

	it('throws when the endpoint returns non-JSON or a non-array', async () => {
		const server = makeServer();
		const base = server.fetchFn;
		const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/endpoint/500/')) {
				return {
					status: 200,
					headers: new Headers(),
					text: async () => '<html>oops</html>',
					json: async () => {
						throw new SyntaxError('not json');
					},
				} as unknown as Response;
			}
			return base(input, init);
		}) as typeof fetch;
		const client = createOpenfieldClient({ baseUrl: BASE, username: 'bot', password: 'pw' }, fetchFn);
		await expect(client.fetchToday(500)).rejects.toThrow(/non-JSON/);
	});
});
