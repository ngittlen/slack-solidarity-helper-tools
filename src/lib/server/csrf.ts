// Replacement for SvelteKit's built-in CSRF origin check, which we disable in
// svelte.config.js (`csrf.trustedOrigins: ['*']`).
//
// Why it had to be disabled: Slack posts slash commands and interactivity
// payloads as `application/x-www-form-urlencoded` with **no `Origin` header**.
// Kit's check (runtime/server/respond.js) treats a missing origin as forbidden:
//
//   is_form_content_type(request) && POST/PUT/PATCH/DELETE &&
//   request_origin !== url.origin &&
//   (!request_origin || !csrf_trusted_origins.includes(request_origin))
//
// The `!request_origin` arm short-circuits to "forbidden" no matter what is in
// `trustedOrigins`, so adding Slack's origin to the allowlist cannot work —
// only turning the check off does. Worse, the whole block is wrapped in
// `if (!__SVELTEKIT_DEV__)`, so the 403 appears **only in production**.
//
// This module re-implements the same rule with one carve-out: the
// `/api/slack/*` routes, which authenticate every request by verifying Slack's
// HMAC signature over the raw body (see slack-signature.ts). That signature is
// a strictly stronger check than an Origin header — an attacker forging a
// cross-site form post cannot produce it.
//
// Net protection is unchanged for the rest of the app: the only same-origin
// form POST is /auth/logout, and every other mutation is a JSON `fetch`, which
// Kit's original check already exempted (JSON is not a form content type).

/** Content types Kit treats as CSRF-vulnerable — a cross-origin <form> can
 *  produce these without a preflight. Mirrors `is_form_content_type`. */
const FORM_CONTENT_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
];

const PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Path prefix exempted because it is signature-verified instead. */
const SIGNATURE_VERIFIED_PREFIX = '/api/slack/';

function isFormContentType(request: Request): boolean {
	// Strip parameters (`; charset=utf-8`, `; boundary=…`) and normalize.
	const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
	return FORM_CONTENT_TYPES.includes(type);
}

/**
 * `true` when this request is a cross-site form submission that should be
 * rejected with a 403.
 *
 * Exported as a pure function (no SvelteKit types, no `dev` import) so the rule
 * is unit-testable without standing up a request event.
 */
export function isCrossSiteFormPost(request: Request, url: URL): boolean {
	if (!PROTECTED_METHODS.has(request.method)) return false;
	if (!isFormContentType(request)) return false;
	// Slack requests carry no Origin but do carry a verified signature.
	if (url.pathname.startsWith(SIGNATURE_VERIFIED_PREFIX)) return false;
	return request.headers.get('origin') !== url.origin;
}
