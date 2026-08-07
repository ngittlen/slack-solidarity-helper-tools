import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { memberAccountLinks } from '$lib/server/schema.js';
import { getSolidarityMembers } from '$lib/server/autocomplete-sources.js';
import { errMessage } from '$lib/err-message.js';

// Create or remove an admin-made Slack -> Solidarity link. Action-discriminated
// body, mirroring /api/settings/allowed-users.

interface LinkBody {
	action?: unknown;
	slackUserId?: unknown;
	solidarityUserId?: unknown;
}

const SLACK_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: LinkBody;
	try {
		body = (await request.json()) as LinkBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const slackUserId = body.slackUserId;
	if (typeof slackUserId !== 'string' || !SLACK_ID_PATTERN.test(slackUserId)) {
		return json({ error: 'slackUserId must be a Slack user id' }, { status: 400 });
	}

	// Unlink is not optional politeness: mis-linking is the predictable failure
	// mode of a manual-link feature, and the way back shouldn't be a DB console.
	if (body.action === 'unlink') {
		await db.delete(memberAccountLinks).where(eq(memberAccountLinks.slackUserId, slackUserId));
		console.log(`[member-page] ${locals.session.slackUserId} unlinked ${slackUserId}`);
		return json({ ok: true });
	}

	if (body.action !== 'link') {
		return json({ error: 'action must be "link" or "unlink"' }, { status: 400 });
	}

	const solidarityUserId = body.solidarityUserId;
	if (typeof solidarityUserId !== 'number' || !Number.isInteger(solidarityUserId)) {
		return json({ error: 'solidarityUserId must be an integer' }, { status: 400 });
	}

	// Validate against the cached roster rather than a fresh GET /v1/users/{id}:
	// the id came from that roster in the first place, so this costs no API
	// calls and still rejects a hand-crafted request.
	let roster;
	try {
		({ items: roster } = await getSolidarityMembers(SOLIDARITY_API_TOKEN));
	} catch (err) {
		console.error('[member-page] roster unavailable while linking:', errMessage(err));
		return json(
			{ error: 'The Solidarity member list is unavailable right now. Try again in a moment.' },
			{ status: 503 },
		);
	}

	const target = roster.find((m) => m.id === solidarityUserId);
	if (!target) {
		return json({ error: 'That Solidarity account no longer exists.' }, { status: 400 });
	}

	const now = new Date().toISOString();
	const editorName = locals.session.slackUserName ?? locals.session.slackUserId;

	await db
		.insert(memberAccountLinks)
		.values({
			slackUserId,
			solidarityUserId,
			solidarityEmail: target.email || null,
			linkedBy: locals.session.slackUserId,
			linkedByName: editorName,
			linkedAt: now,
		})
		.onConflictDoUpdate({
			target: memberAccountLinks.slackUserId,
			set: {
				solidarityUserId,
				solidarityEmail: target.email || null,
				linkedBy: locals.session.slackUserId,
				linkedByName: editorName,
				linkedAt: now,
			},
		});

	console.log(
		`[member-page] ${locals.session.slackUserId} linked ${slackUserId} -> solidarity ${solidarityUserId}`,
	);
	return json({ ok: true });
};
