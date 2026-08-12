import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { getSlackChannels } from '$lib/server/autocomplete-sources.js';
import {
	saveInfoCommand,
	deleteInfoCommand,
	findInfoCommand,
	type Editor,
} from '$lib/server/settings.js';
import {
	validateCommandName,
	validateInfoMessage,
	normalizeCommandName,
} from '$lib/info-command.js';

// Create / edit / delete the admin-defined info commands, one operation per
// request, in the same shape as the allowed-users editor.
//
// The `#channel-name` tokens in a message are checked against the live channel
// list before the row is stored, exactly as the DM templates are: a typo'd
// channel would otherwise post as literal text to a whole channel before
// anyone noticed. A Slack outage is reported as 503 rather than swallowed —
// storing a message whose channels were never verified defeats the check.
//
// Renaming is a delete + insert, since the command name is the primary key.
// `previousCommand` carries the old name so the rename doesn't strand a row.

interface InfoCommandsBody {
	action?: unknown;
	command?: unknown;
	message?: unknown;
	previousCommand?: unknown;
}

const TRANSIENT_CHANNELS =
	'Could not reach Slack to check the channel names. Please try again in a moment.';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: InfoCommandsBody;
	try {
		body = (await request.json()) as InfoCommandsBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action } = body;
	if (action !== 'save' && action !== 'delete') {
		return json({ error: 'action must be "save" or "delete"' }, { status: 400 });
	}
	if (typeof body.command !== 'string') {
		return json({ error: 'command must be a string' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	// Delete only normalizes — a row whose name would no longer pass validation
	// (say, because the reserved list grew) must still be removable.
	if (action === 'delete') {
		const command = normalizeCommandName(body.command);
		if (command === '') {
			return json({ error: 'command must be a non-empty string' }, { status: 400 });
		}
		await deleteInfoCommand(db, command, editor);
		return json({ ok: true });
	}

	const nameCheck = validateCommandName(body.command);
	if (!nameCheck.ok) {
		return json({ error: nameCheck.error }, { status: 400 });
	}
	const { command } = nameCheck;

	const messageCheck = validateInfoMessage(body.message);
	if (!messageCheck.ok) {
		return json({ error: messageCheck.error }, { status: 400 });
	}
	const { message, channelNames } = messageCheck;

	if (channelNames.length > 0) {
		let items;
		try {
			({ items } = await getSlackChannels(slack));
		} catch {
			return json({ error: TRANSIENT_CHANNELS }, { status: 503 });
		}
		const known = new Set(items.map((c) => c.name.toLowerCase()));
		const unknown = channelNames.filter((n) => !known.has(n));
		if (unknown.length > 0) {
			return json(
				{ error: `Unknown channel(s): ${unknown.map((n) => `#${n}`).join(', ')}` },
				{ status: 400 },
			);
		}
	}

	const previousCommand =
		typeof body.previousCommand === 'string' ? normalizeCommandName(body.previousCommand) : '';
	const isRename = previousCommand !== '' && previousCommand !== command;

	// Checked on create and on rename, not on an in-place edit — an edit is
	// expected to hit its own row. Without this, renaming onto an existing name
	// would silently overwrite that command's message.
	if (previousCommand === '' || isRename) {
		if (await findInfoCommand(db, command)) {
			return json({ error: `${command} already exists.` }, { status: 409 });
		}
	}

	await saveInfoCommand(db, { command, message }, editor);
	if (isRename) {
		await deleteInfoCommand(db, previousCommand, editor);
	}

	return json({ ok: true, command });
};
