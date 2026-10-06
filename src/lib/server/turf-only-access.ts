// What an outside sign-in (Google or Apple) may reach: turf checkout, and
// nothing else.
//
// Anyone with a Google account or an Apple ID can sign in
// (specs/013-google-sso-login, specs/014-apple-sso-login), so an outside
// session is a stranger's session. Everything else this app serves —
// the dashboard, member lookup, the help queue, settings, the organizer turf
// views — was built for people the Slack workspace had already let in, and
// much of it guards nothing beyond "has a session" (the root layout's check).
//
// So the rule is deny-by-default, applied once in hooks.server.ts to every
// request, and expressed as an allow-list of route ids. A route added tomorrow
// is closed to outside sessions until someone adds it here — which is a
// decision to publish that route to the internet, and should be taken as one.
// turf-only-access.test.ts walks src/routes and pins this list, so widening it
// means editing the test too.
//
// Why hooks rather than the root layout: form actions never run layout loads,
// `+server.ts` endpoints never run them either, and layout and page loads run
// concurrently, so a layout redirect would still let a page load do its work.

import { sanitizeRedirectTarget } from './post-login-redirect.js';

/** Route ids (SvelteKit's `event.route.id`) an outside session may use. One
 *  list for both providers, so what Google and Apple volunteers can reach
 *  cannot drift apart (FR-012 of specs/014-apple-sso-login). */
export const TURF_ONLY_ROUTES: ReadonlySet<string> = new Set([
	// Turf checkout itself: the page (its __data.json and its `nearby` action
	// share the id) and the API the map calls.
	'/turfs',
	'/api/turfs',
	'/api/turfs/[turfId]',
	// Signing in, out, and across to Slack. The Slack callback refuses the
	// post-as-you grant to anyone who is not an admin or moderator on its own.
	'/signin',
	'/auth/logout',
	'/auth/google',
	'/auth/google/callback',
	'/auth/apple',
	'/auth/apple/callback',
	'/auth/slack',
	'/auth/slack/callback',
	// Already public to everyone.
	'/policies',
	'/privacy',
	'/security',
	'/terms',
	'/health',
]);

export type TurfOnlyGate =
	{ action: 'allow' } | { action: 'redirect'; location: string } | { action: 'forbid' };

/**
 * What to do with a request made under an outside (Google or Apple) session.
 *
 * A page someone navigated to is answered with a redirect to /turfs, carrying
 * where they were trying to go so /turfs can explain and offer Slack sign-in
 * back to it. Everything else — an API call, a form post — gets a 403.
 */
export function gateTurfOnlySession(request: {
	routeId: string | null;
	isDataRequest: boolean;
	/** A SvelteKit remote function call. These match no route, so without
	 *  this they would read as a 404 and slip through the null-route rule. */
	isRemoteRequest: boolean;
	method: string;
	accept: string | null;
	url: URL;
}): TurfOnlyGate {
	// A remote function runs code without matching a route, so it would look
	// like the 404 below. None exist yet; when one does, it is closed to
	// outside sessions by default like everything else here.
	if (request.isRemoteRequest) return { action: 'forbid' };
	// No route matched: a 404 page, which reveals nothing. Only a read,
	// though — anything else with no route is refused rather than assumed
	// harmless.
	if (request.routeId === null) {
		return request.method === 'GET' || request.method === 'HEAD'
			? { action: 'allow' }
			: { action: 'forbid' };
	}
	if (TURF_ONLY_ROUTES.has(request.routeId)) return { action: 'allow' };

	const isPageRequest =
		request.isDataRequest ||
		((request.method === 'GET' || request.method === 'HEAD') &&
			(request.accept ?? '').includes('text/html'));
	if (!isPageRequest) return { action: 'forbid' };

	// `url` here is the page's own URL — Kit strips the __data.json suffix
	// before handle runs.
	const target = sanitizeRedirectTarget(request.url.pathname + request.url.search);
	return {
		action: 'redirect',
		location: `/turfs?needsSlack=${encodeURIComponent(target ?? '1')}`,
	};
}
