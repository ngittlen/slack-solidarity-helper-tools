import { json, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { verifySlackSignature } from '$lib/server/slack-signature.js';
import { isSlackAdmin, NOT_AUTHORIZED_TEXT } from '$lib/server/slack-admin.js';
import { buildNoteModal, parseCommandTarget } from '$lib/server/slack-modal.js';
import { errMessage } from '$lib/err-message.js';

// Slash commands. Currently just /member-note, which opens the note/warning
// modal.
//
// Two things differ from the events route: Slack sends slash commands as
// `application/x-www-form-urlencoded` (so the body is parsed with
// URLSearchParams, not JSON.parse), and those requests carry no Origin header —
// which is why /api/slack/* is exempt from the CSRF check in
// src/lib/server/csrf.ts. The signature verification below is what replaces it.

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.text();

	if (!(await verifySlackSignature(request, body))) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const form = new URLSearchParams(body);
	const command = form.get('command') ?? '';
	const slackUserId = form.get('user_id') ?? '';
	const triggerId = form.get('trigger_id') ?? '';
	const channelId = form.get('channel_id');
	const commandText = form.get('text') ?? '';

	if (command !== '/member-note') {
		console.warn(`[member-note] unrecognized command "${command}"`);
		return ephemeral('Unrecognized command.');
	}

	if (!(await isSlackAdmin(slackUserId))) {
		// 200 with an ephemeral body — only the person who typed it sees this.
		return ephemeral(NOT_AUTHORIZED_TEXT);
	}

	if (!triggerId) {
		return ephemeral('Slack did not send a trigger id, so the dialog cannot be opened.');
	}

	// Awaited rather than fire-and-forget: this is a single ~200ms call, well
	// inside Slack's 3-second budget, and if it fails the admin needs to be told
	// rather than left staring at nothing. The trigger_id also expires in about
	// three seconds, so there is nothing to gain by deferring it.
	try {
		const { warningDmMessage } = await loadSettings(db);
		await slack.views.open({
			trigger_id: triggerId,
			view: buildNoteModal(
				// `<@U123|name>` only arrives if "Escape channels, users, and
				// links" is enabled on the command; without it we simply open
				// the modal with no member preselected.
				{ slackUserId: parseCommandTarget(commandText) },
				{ channelId, source: 'slash', warningTemplate: warningDmMessage },
			),
		});
	} catch (err) {
		console.error('[member-note] views.open failed:', errMessage(err));
		return ephemeral('Could not open the note dialog. Please try again.');
	}

	// Empty 200 — the modal is the response; echoing text would just clutter
	// the channel.
	return text('', { status: 200 });
};

function ephemeral(message: string): Response {
	return json({ response_type: 'ephemeral', text: message });
}
