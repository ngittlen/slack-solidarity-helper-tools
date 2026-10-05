import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { gateGoogleSession, GOOGLE_SESSION_ROUTES } from './google-access.js';

// SC-002 of specs/013-google-sso-login: every route outside turf checkout
// refuses a Google session. Walks the real src/routes tree, so a route added
// later is checked without anyone remembering to add it here.

const ROUTES_DIR = fileURLToPath(new URL('../../routes', import.meta.url));
const ROUTE_FILES = new Set(['+page.svelte', '+page.server.ts', '+page.ts', '+server.ts']);

/** Every SvelteKit route id under src/routes, as `event.route.id` spells it. */
function routeIds(dir = ROUTES_DIR): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const ids = entries.some((e) => e.isFile() && ROUTE_FILES.has(e.name))
		? ['/' + relative(ROUTES_DIR, dir).split(sep).join('/')]
		: [];
	for (const e of entries) if (e.isDirectory()) ids.push(...routeIds(join(dir, e.name)));
	return ids;
}

/** A concrete URL for a route id, filling each [param] with a placeholder. */
function urlFor(routeId: string, search = ''): URL {
	return new URL(`http://app.test${routeId.replace(/\[[^\]]+\]/g, '1')}${search}`);
}

function htmlGet(routeId: string) {
	return gateGoogleSession({
		routeId,
		isDataRequest: false,
		isRemoteRequest: false,
		method: 'GET',
		accept: 'text/html,application/xhtml+xml',
		url: urlFor(routeId),
	});
}

function jsonPost(routeId: string) {
	return gateGoogleSession({
		routeId,
		isDataRequest: false,
		isRemoteRequest: false,
		method: 'POST',
		accept: 'application/json',
		url: urlFor(routeId),
	});
}

const ALL_ROUTES = routeIds();

describe('the Google-session allow-list', () => {
	it('finds the routes it is meant to be checking', () => {
		// Guards the walk itself: an empty or wrong-rooted walk would pass
		// every assertion below vacuously.
		expect(ALL_ROUTES).toContain('/');
		expect(ALL_ROUTES).toContain('/settings');
		expect(ALL_ROUTES).toContain('/api/turfs/[turfId]');
		expect(ALL_ROUTES.length).toBeGreaterThan(40);
	});

	// Widening this list publishes a route to anyone with a Google account.
	// Changing it should mean changing this test, on purpose.
	it('is exactly the turf checkout, sign-in and public routes', () => {
		expect([...GOOGLE_SESSION_ROUTES].sort()).toEqual(
			[
				'/turfs',
				'/api/turfs',
				'/api/turfs/[turfId]',
				'/signin',
				'/auth/logout',
				'/auth/google',
				'/auth/google/callback',
				'/auth/slack',
				'/auth/slack/callback',
				'/policies',
				'/privacy',
				'/security',
				'/terms',
				'/health',
			].sort(),
		);
	});

	it('names only routes that exist', () => {
		for (const id of GOOGLE_SESSION_ROUTES) expect(ALL_ROUTES, id).toContain(id);
	});

	it('allows every listed route, page or API', () => {
		for (const id of GOOGLE_SESSION_ROUTES) {
			expect(htmlGet(id), id).toEqual({ action: 'allow' });
			expect(jsonPost(id), id).toEqual({ action: 'allow' });
		}
	});
});

describe('gateGoogleSession', () => {
	const denied = ALL_ROUTES.filter((id) => !GOOGLE_SESSION_ROUTES.has(id));

	it('denies every other route in the app', () => {
		expect(denied.length).toBeGreaterThan(0);
		for (const id of denied) {
			expect(htmlGet(id).action, id).toBe('redirect');
			expect(jsonPost(id), id).toEqual({ action: 'forbid' });
		}
	});

	it('denies the organizer pages under /turfs and the post-as-you grant', () => {
		for (const id of [
			'/turfs/organizer',
			'/turfs/activity',
			'/turfs/folder-map',
			'/turfs/sheet-map',
			'/auth/slack/post-as-you',
			'/auth/dev-login',
		]) {
			expect(denied, id).toContain(id);
		}
	});

	it('sends a page request to /turfs, carrying where it was going', () => {
		expect(
			gateGoogleSession({
				routeId: '/members',
				isDataRequest: false,
				isRemoteRequest: false,
				method: 'GET',
				accept: 'text/html',
				url: new URL('http://app.test/members?user=U123'),
			}),
		).toEqual({ action: 'redirect', location: '/turfs?needsSlack=%2Fmembers%3Fuser%3DU123' });
	});

	it('redirects a client-side navigation (a data request) the same way', () => {
		expect(
			gateGoogleSession({
				routeId: '/',
				isDataRequest: true,
				isRemoteRequest: false,
				method: 'GET',
				accept: '*/*',
				url: new URL('http://app.test/'),
			}),
		).toEqual({ action: 'redirect', location: '/turfs?needsSlack=%2F' });
	});

	it('forbids a GET that does not want HTML — an API call, not a page', () => {
		expect(
			gateGoogleSession({
				routeId: '/api/pending',
				isDataRequest: false,
				isRemoteRequest: false,
				method: 'GET',
				accept: null,
				url: urlFor('/api/pending'),
			}),
		).toEqual({ action: 'forbid' });
	});

	it('forbids a form post to a denied page', () => {
		expect(
			gateGoogleSession({
				routeId: '/post-as-you',
				isDataRequest: false,
				isRemoteRequest: false,
				method: 'POST',
				accept: 'text/html',
				url: urlFor('/post-as-you', '?/turnOff'),
			}),
		).toEqual({ action: 'forbid' });
	});

	it('refuses a remote function call, which matches no route', () => {
		expect(
			gateGoogleSession({
				routeId: null,
				isDataRequest: false,
				isRemoteRequest: true,
				method: 'POST',
				accept: 'application/json',
				url: new URL('http://app.test/_app/remote/abc/doThing'),
			}),
		).toEqual({ action: 'forbid' });
	});

	it('refuses anything but a read to an unmatched route', () => {
		expect(
			gateGoogleSession({
				routeId: null,
				isDataRequest: false,
				isRemoteRequest: false,
				method: 'POST',
				accept: 'text/html',
				url: new URL('http://app.test/no-such-page'),
			}),
		).toEqual({ action: 'forbid' });
	});

	it('allows an unmatched route, so the 404 page renders', () => {
		expect(
			gateGoogleSession({
				routeId: null,
				isDataRequest: false,
				isRemoteRequest: false,
				method: 'GET',
				accept: 'text/html',
				url: new URL('http://app.test/no-such-page'),
			}),
		).toEqual({ action: 'allow' });
	});

	it('carries a placeholder rather than an unsafe destination', () => {
		const tooLong = `/settings?x=${'a'.repeat(600)}`;
		expect(
			gateGoogleSession({
				routeId: '/settings',
				isDataRequest: false,
				isRemoteRequest: false,
				method: 'GET',
				accept: 'text/html',
				url: new URL(`http://app.test${tooLong}`),
			}),
		).toEqual({ action: 'redirect', location: '/turfs?needsSlack=1' });
	});
});
