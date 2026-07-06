import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SLACK_SUPERUSER_ID } from '$lib/server/env.js';
import { getSlackUsers } from '$lib/server/autocomplete-sources.js';
import {
	ensureAllowedUsersSeeded,
	saveAllowedUser,
	deleteAllowedUser,
	type Editor,
} from '$lib/server/settings.js';
import { validateSlackUser } from '$lib/server/settings-validation.js';

// Admin-allowlist writes for the settings page: one add/remove of one Slack
// user per request. `add` membership-checks the id against the cached live
// user list (503 on a transient list outage, 400 for an unknown id) and stores
// the validated display name; `remove` only shape-validates so a stale entry
// (deactivated user) can always be deleted.
//
// Guardrail: you cannot remove your own id — one accidental chip-click
// shouldn't cost the clicker their access. The superuser is exempt (they stay
// admin via SLACK_SUPERUSER_ID no matter what the list says), and a mis-edit
// by someone else is recoverable through the superuser escape hatch.
interface AllowedUsersBody {
	action?: unknown;
	userId?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: AllowedUsersBody;
	try {
		body = (await request.json()) as AllowedUsersBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, userId } = body;
	if (action !== 'add' && action !== 'remove') {
		return json({ error: 'action must be "add" or "remove"' }, { status: 400 });
	}
	if (typeof userId !== 'string' || userId.trim() === '') {
		return json({ error: 'userId must be a non-empty string' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	// Best-effort display names for the one-time env seed. A Slack outage must
	// not block the write itself — seed rows just fall back to raw ids.
	async function seedDisplayNames(): Promise<ReadonlyMap<string, string> | undefined> {
		try {
			const { items } = await getSlackUsers(slack);
			return new Map(items.map((u) => [u.id, u.name]));
		} catch {
			return undefined;
		}
	}

	if (action === 'add') {
		const result = await validateSlackUser(slack, userId);
		if (!result.ok) {
			return json({ error: result.error }, { status: result.transient ? 503 : 400 });
		}
		await ensureAllowedUsersSeeded(db, await seedDisplayNames());
		await saveAllowedUser(db, { slackUserId: userId, displayName: result.displayName }, editor);
		return json({ ok: true });
	}

	if (userId === locals.session.slackUserId && userId !== SLACK_SUPERUSER_ID) {
		return json(
			{ error: 'You cannot remove your own admin access. Ask another admin to remove you.' },
			{ status: 400 },
		);
	}
	await ensureAllowedUsersSeeded(db, await seedDisplayNames());
	await deleteAllowedUser(db, userId, editor);
	return json({ ok: true });
};
