import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SLACK_SUPERUSER_ID } from '$lib/server/env.js';
import { loadSettings, type Editor } from '$lib/server/settings.js';
import { validateSlackUser } from '$lib/server/settings-validation.js';
import { blockFromTurfCheckout, unblockFromTurfCheckout } from '$lib/server/van/blocklist.js';
import { canBlock } from '$lib/van/access.js';
import {
	renderBlockNotice,
	renderBlockedHolderDm,
	renderUnblockNotice,
} from '$lib/van/blocklist-notice.js';
import { sendDm } from '$lib/server/slack-dm.js';
import { errMessage } from '$lib/err-message.js';

// Block / unblock one Slack user from turf checkout.
//
// `block` is not a simple insert: it also releases any turf the person is
// holding and ends their sessions, so the block takes effect on their next
// request rather than up to eight hours later. That whole sequence lives in
// $lib/server/van/blocklist.js; this handler owns auth, parsing and the
// admin-safety check.
//
// `unblock` only shape-validates the id, so a stale entry (deactivated Slack
// account) can always be removed.
interface BlocklistBody {
	action?: unknown;
	userId?: unknown;
	reason?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: BlocklistBody;
	try {
		body = (await request.json()) as BlocklistBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, userId, reason } = body;
	if (action !== 'block' && action !== 'unblock') {
		return json({ error: 'action must be "block" or "unblock"' }, { status: 400 });
	}
	if (typeof userId !== 'string' || userId.trim() === '') {
		return json({ error: 'userId must be a non-empty string' }, { status: 400 });
	}
	if (reason !== undefined && typeof reason !== 'string') {
		return json({ error: 'reason must be a string' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'unblock') {
		await unblockFromTurfCheckout(db, userId, editor);
		void announce(renderUnblockNotice(userId, editor.id));
		return json({ ok: true });
	}

	// Admins and the superuser can't be blocked — otherwise one chip-click could
	// lock the campaign out of its own tool. Refused loudly rather than dropped
	// silently, so the admin learns why nothing happened.
	const settings = await loadSettings(db);
	const decision = canBlock(locals.session.slackUserId, userId, {
		adminSlackUserIds: settings.allowedSlackUserIds,
		superuserSlackUserId: SLACK_SUPERUSER_ID || undefined,
	});
	if (!decision.ok) {
		return json({ error: decision.message }, { status: 400 });
	}

	const result = await validateSlackUser(slack, userId);
	if (!result.ok) {
		return json({ error: result.error }, { status: result.transient ? 503 : 400 });
	}

	const { released, sessionsRevoked } = await blockFromTurfCheckout(
		db,
		{ slackUserId: userId, displayName: result.displayName, reason: reason ?? '' },
		editor,
	);

	// Both detached. The block is already written and is the thing that had to
	// succeed; a Slack outage must not turn it into a 500 the admin retries,
	// which would re-run the whole sequence against a user who is already
	// blocked.
	const turfNames = released.map((r) => r.name);
	void announce(
		renderBlockNotice({
			targetSlackUserId: userId,
			actorSlackUserId: editor.id,
			reason: reason ?? '',
			releasedTurfNames: turfNames,
			sessionsRevoked,
		}),
	);

	// Only when the block actually took turf off them. Someone walking to a
	// block that is no longer theirs is the failure this prevents; with nothing
	// released there is nothing to prevent.
	const dm = renderBlockedHolderDm(turfNames);
	if (dm) void sendDm(userId, dm, '[van]');

	// Returned so the editor can tell the admin what the block actually did —
	// "also freed 2 turfs" is the part they need to know about.
	return json({ ok: true, releasedTurfs: released.length, sessionsRevoked });
};

/**
 * Post a `[van]` line to the member notes channel.
 *
 * Reuses that channel rather than adding a turf-specific one: it is already
 * documented as the private admin channel and already carries moderation
 * ("Note added to user @person by @admin"). Cutting someone off from turf is
 * the same kind of act, read by the same people.
 *
 * Never throws, and silent when no channel is configured — the same opt-in
 * shape the note flow uses.
 */
async function announce(text: string): Promise<void> {
	try {
		const { slackMemberNoteChannelId } = await loadSettings(db);
		if (!slackMemberNoteChannelId) return;
		await slack.chat.postMessage({
			channel: slackMemberNoteChannelId,
			text,
			blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
		});
	} catch (err) {
		console.error('[van] could not post the blocklist notice:', errMessage(err));
	}
}
