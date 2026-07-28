// Openfield (openfield.ai) client for the door-knocking snapshot.
//
// Openfield has no API tokens — it's a Django app with form login, so this
// client logs in like a volunteer (username/password → sessionid cookie) and
// then:
//   - resolveCode(code):  POST /codes/ with a 6-char conversation code; the
//     app answers 302 to the conversation's page — /street/<id>/ for
//     street-canvass conversations, /<id>/ for door-knocking ones — which is
//     the only place the numeric conversation id is exposed. Codes Openfield
//     no longer recognizes get a 404 (observed for retired canvas codes).
//   - fetchToday(id):     GET /endpoint/<id>/today/ — the JSON leaderboard
//     for the CURRENT day only (hence the nightly snapshot). The trailing
//     slash matters: Django 301s without it for door-knock conversations.
//     One logged-in session can read any conversation id; no need to switch
//     codes first.
//
// Same import discipline as solidarity.ts: no $env/$lib imports — config and
// fetch are injected so tests run without a network.

import { errMessage } from '../err-message.js';

export interface OpenfieldConfig {
	/** e.g. https://abdulforsenate.openfield.ai — no trailing slash. */
	baseUrl: string;
	username: string;
	password: string;
}

export interface OpenfieldLeaderboardRow {
	canvasser: string;
	attempts: number;
	contact: number;
}

export interface OpenfieldClient {
	/** Numeric conversation id for a 6-char code, or null when Openfield
	 *  doesn't recognize the code. */
	resolveCode(code: string): Promise<number | null>;
	/** Today's per-canvasser leaderboard for a conversation id. Empty array =
	 *  no activity today (a real zero, not an error). */
	fetchToday(conversationId: number): Promise<OpenfieldLeaderboardRow[]>;
}

type FetchFn = typeof fetch;

const CSRF_INPUT_RE = /name="csrfmiddlewaretoken"\s+value="([^"]+)"/;
// First numeric path segment of the post-code redirect: /street/6/ (street
// conversations) or /1230/ (door-knocking conversations).
const CONVERSATION_ID_RE = /\/(\d+)\//;

export function createOpenfieldClient(
	config: OpenfieldConfig,
	fetchFn: FetchFn = fetch,
): OpenfieldClient {
	// Minimal cookie jar — Openfield only sets csrftoken and sessionid, both
	// path=/. Django rotates csrftoken on login; last write wins.
	const cookies = new Map<string, string>();

	function storeCookies(res: Response): void {
		for (const line of res.headers.getSetCookie()) {
			const [pair] = line.split(';');
			const eq = pair!.indexOf('=');
			if (eq > 0) cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
		}
	}

	function cookieHeader(): string {
		return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	async function get(path: string): Promise<Response> {
		const res = await fetchFn(`${config.baseUrl}${path}`, {
			headers: { Cookie: cookieHeader() },
			redirect: 'manual',
		});
		storeCookies(res);
		return res;
	}

	/** GET a page and POST a form back to it with the CSRF pieces Django
	 *  requires (csrftoken cookie + csrfmiddlewaretoken field + Referer). */
	async function postForm(path: string, fields: Record<string, string>): Promise<Response> {
		const page = await get(path);
		// An expired session redirects the form GET to login; surface that
		// response so authed() can re-login and retry, rather than failing on
		// the missing CSRF token.
		if (isLoginRedirect(page)) return page;
		const html = await page.text();
		const token = CSRF_INPUT_RE.exec(html)?.[1];
		if (!token) {
			throw new Error(`openfield: no CSRF token on ${path} (page status ${page.status})`);
		}
		const body = new URLSearchParams({ csrfmiddlewaretoken: token, ...fields });
		const res = await fetchFn(`${config.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				Cookie: cookieHeader(),
				'Content-Type': 'application/x-www-form-urlencoded',
				Referer: `${config.baseUrl}${path}`,
			},
			body: body.toString(),
			redirect: 'manual',
		});
		storeCookies(res);
		return res;
	}

	// Single-flight login so concurrent callers don't race two logins.
	let loginPromise: Promise<void> | null = null;

	function login(): Promise<void> {
		loginPromise ??= (async () => {
			const res = await postForm('/', {
				username: config.username,
				password: config.password,
			});
			// Django redirects on success and re-renders the form (200) on bad
			// credentials.
			if (res.status !== 302 || !cookies.has('sessionid')) {
				throw new Error(`openfield: login failed (status ${res.status})`);
			}
			console.log('[openfield] logged in');
		})().catch((err) => {
			loginPromise = null; // allow a retry after a failed login
			throw err;
		});
		return loginPromise;
	}

	function isLoginRedirect(res: Response): boolean {
		const location = res.headers.get('location') ?? '';
		return res.status === 302 && location.includes('next=');
	}

	/** Run an authenticated request; on a redirect-to-login (expired session),
	 *  re-login once and retry. */
	async function authed(run: () => Promise<Response>): Promise<Response> {
		await login();
		let res = await run();
		if (isLoginRedirect(res)) {
			loginPromise = null;
			cookies.delete('sessionid');
			await login();
			res = await run();
		}
		return res;
	}

	return {
		async resolveCode(code: string): Promise<number | null> {
			const res = await authed(() => postForm('/codes/', { code }));
			if (res.status === 302) {
				const id = CONVERSATION_ID_RE.exec(res.headers.get('location') ?? '')?.[1];
				if (id) return Number(id);
			}
			// 404 = Openfield doesn't know this code (retired canvas entry).
			console.warn(`[openfield] could not resolve code ${code} (status ${res.status})`);
			return null;
		},

		async fetchToday(conversationId: number): Promise<OpenfieldLeaderboardRow[]> {
			const res = await authed(() => get(`/endpoint/${conversationId}/today/?search=&order=asc`));
			if (res.status !== 200) {
				throw new Error(`openfield: /endpoint/${conversationId}/today/ returned ${res.status}`);
			}
			let rows: unknown;
			try {
				rows = await res.json();
			} catch (err) {
				throw new Error(
					`openfield: /endpoint/${conversationId}/today returned non-JSON: ${errMessage(err)}`,
					{ cause: err },
				);
			}
			if (!Array.isArray(rows)) {
				throw new Error(`openfield: /endpoint/${conversationId}/today returned a non-array`);
			}
			return rows.map((r) => {
				const row = r as Record<string, unknown>;
				return {
					canvasser: typeof row.canvasser === 'string' ? row.canvasser : '',
					attempts: typeof row.attempts === 'number' ? row.attempts : 0,
					contact: typeof row.contact === 'number' ? row.contact : 0,
				};
			});
		},
	};
}
