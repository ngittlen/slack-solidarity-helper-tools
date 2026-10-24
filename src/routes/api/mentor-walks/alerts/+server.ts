import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { SLACK_SUPERUSER_ID } from '$lib/server/env.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { turfAccess } from '$lib/van/access.js';
import { recordRequest } from '$lib/van/request-budget.js';
import { pruneRateLimitStores, turfRequests } from '$lib/server/van/rate-limit-store.js';
import {
	answerFinderPrompt,
	loadAlertsView,
	saveAlertsAction,
	stopAlertsAction,
	type PanelContext,
} from '$lib/server/mentor-walks/panel.js';

// Nearby mentor-walk alerts (specs/015-mentor-walks, User Story 7, FR-027),
// for the header's bell, which sits on every page.
//
// GET: { alerts: { zip, radius } | null }, or { alerts: null, available:
//      false } when the feature is hidden from this person: blocked, the
//      setting, or no name yet. The bell then leaves the section out (FR-039).
// PUT { zip, radius, fromPrompt? }: turn them on or change them. `fromPrompt`
//      is the new-person prompt's "Tell me when…", which also answers it Yes.
// DELETE: turn them off. Allowed whatever the setting: nobody should be
//      unable to stop messages.

async function context(session: NonNullable<App.Locals['session']>): Promise<PanelContext> {
	const [settings, blockedIds] = await Promise.all([loadSettings(db), loadVanBlockedIds(db)]);
	const access = turfAccess(
		{ slackUserId: session.slackUserId, isAdmin: session.isAdmin },
		blockedIds,
		SLACK_SUPERUSER_ID,
	);
	return { viewer: session, settings, blocked: !access.allowed, now: new Date() };
}

export const GET: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });
	if (session.needsName) return json({ alerts: null, available: false });
	const view = await loadAlertsView(db, await context(session));
	return json(view ? { alerts: view.alerts, available: true } : { alerts: null, available: false });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });
	if (session.needsName) return json({ error: 'Choose your name first.' }, { status: 403 });

	// Each save looks a ZIP up, so it shares the turf pages' request budget.
	const now = Date.now();
	pruneRateLimitStores(now);
	const budget = recordRequest(turfRequests, session.slackUserId, now, {
		exempt: session.isAdmin,
	});
	if (!budget.allowed) {
		return json(
			{ error: 'Too many requests. Slow down and try again shortly.' },
			{ status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
		);
	}

	let body: { zip?: unknown; radius?: unknown; fromPrompt?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'Malformed request' }, { status: 400 });
	}
	const ctx = await context(session);
	const result = await saveAlertsAction(
		db,
		ctx,
		typeof body.zip === 'string' ? body.zip : '',
		typeof body.radius === 'number' || typeof body.radius === 'string' ? String(body.radius) : '',
	);
	if (!result.ok) return json({ error: result.message }, { status: result.status });
	// Wanting alerts is a Yes to the prompt. Only from the prompt, and
	// nothing to undo if they'd already answered it some other way.
	if (body.fromPrompt === true) await answerFinderPrompt(db, ctx, 'yes');
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });
	await stopAlertsAction(db, await context(session));
	return json({ ok: true });
};
