import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { clearGoogleVolunteers } from '$lib/server/google-volunteers.js';
import { errMessage } from '$lib/err-message.js';

// Clear every stored Google volunteer record — the end-of-campaign step
// (specs/013-google-sso-login, FR-020a). Admin-only, and the one action here.
//
// Blocks and past claims are untouched: a block must outlive the record, and a
// claim keeps the holder's display name on its own row. Volunteers who sign in
// again afterwards simply get a fresh record.

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) return json({ error: 'unauthenticated' }, { status: 401 });
	if (!locals.session.isAdmin) return json({ error: 'unauthorized' }, { status: 403 });

	let body: { action?: unknown };
	try {
		body = (await request.json()) as { action?: unknown };
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	if (body.action !== 'clear') {
		return json({ error: 'action must be "clear"' }, { status: 400 });
	}

	try {
		const cleared = await clearGoogleVolunteers(db);
		console.log(
			`[google] ${locals.session.slackUserName} (${locals.session.slackUserId}) cleared ${cleared} Google volunteer record(s)`,
		);
		return json({ ok: true, cleared });
	} catch (err) {
		console.error('[google] clearing volunteer records failed:', errMessage(err));
		return json({ error: 'Could not clear the records. Please try again.' }, { status: 500 });
	}
};
