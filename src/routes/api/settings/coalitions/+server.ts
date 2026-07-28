import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { saveCoalitionEntry, deleteCoalitionEntry, type Editor } from '$lib/server/settings.js';
import {
	validateSlackChannel,
	validateSolidarityCustomProperty,
	validateSolidarityUserList,
} from '$lib/server/settings-validation.js';

// Coalition ↔ Slack channel mapping writes for the settings page. A coalition
// row is keyed by the Solidarity custom-property internal_name (`group`), with
// a Slack channel and an optional Solidarity user-list id (the reconciliation
// read path). Same validation contract as the chapter-channels endpoint:
// transient list outages → 503 (retry), genuinely-unknown ids → 400.
// `delete` only shape-validates so stale rows are always removable.
interface CoalitionsBody {
	action?: unknown;
	group?: unknown;
	channelId?: unknown;
	userListId?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: CoalitionsBody;
	try {
		body = (await request.json()) as CoalitionsBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, group, channelId, userListId } = body;
	if (action !== 'upsert' && action !== 'delete') {
		return json({ error: 'action must be "upsert" or "delete"' }, { status: 400 });
	}
	if (typeof group !== 'string' || group.trim() === '') {
		return json({ error: 'group must be a non-empty string' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'delete') {
		await deleteCoalitionEntry(db, group, editor);
		return json({ ok: true });
	}

	if (typeof channelId !== 'string' || channelId.trim() === '') {
		return json({ error: 'channelId must be a non-empty string' }, { status: 400 });
	}
	if (userListId !== null && userListId !== undefined && !Number.isInteger(userListId)) {
		return json({ error: 'userListId must be an integer or null' }, { status: 400 });
	}
	const listId = userListId === undefined ? null : (userListId as number | null);

	const [propertyResult, channelResult, listResult] = await Promise.all([
		validateSolidarityCustomProperty(SOLIDARITY_API_TOKEN, group),
		validateSlackChannel(slack, channelId),
		listId === null
			? Promise.resolve({ ok: true as const, name: '' })
			: validateSolidarityUserList(SOLIDARITY_API_TOKEN, listId),
	]);
	for (const result of [propertyResult, channelResult, listResult]) {
		if (!result.ok) {
			return json({ error: result.error }, { status: result.transient ? 503 : 400 });
		}
	}

	await saveCoalitionEntry(
		db,
		{
			group,
			channelId,
			// Display label comes from the validated property definition.
			name: propertyResult.ok ? propertyResult.name : group,
			userListId: listId,
		},
		editor,
	);
	return json({ ok: true });
};
