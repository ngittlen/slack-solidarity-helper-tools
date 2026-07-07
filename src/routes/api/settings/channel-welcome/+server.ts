import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { setChannelWelcomeFlag, type Editor } from '$lib/server/settings.js';

// Per-channel welcome-message toggle for the chapter ↔ channel chips on
// /settings: whether the bot posts its "everybody welcome" message in the
// channel after inviting a new member. Shape-validation only — the chip UI
// only offers channels already in the map, the write is harmless for any id,
// and a toggle must keep working for a channel that has dropped off the live
// list (archived) or while the list is down.
interface ChannelWelcomeBody {
	channelId?: unknown;
	showWelcome?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: ChannelWelcomeBody;
	try {
		body = (await request.json()) as ChannelWelcomeBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { channelId, showWelcome } = body;
	if (typeof channelId !== 'string' || channelId.trim() === '') {
		return json({ error: 'channelId must be a non-empty string' }, { status: 400 });
	}
	if (typeof showWelcome !== 'boolean') {
		return json({ error: 'showWelcome must be a boolean' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	await setChannelWelcomeFlag(db, channelId, showWelcome, editor);
	return json({ ok: true });
};
