import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { saveAppConfig, type AppConfigPatch, type Editor } from '$lib/server/settings.js';
import {
	APP_CONFIG_FIELDS,
	APP_CONFIG_FIELD_KEYS,
	type AppConfigFieldKey,
} from '$lib/server/app-config-fields.js';

// App-config writes for the settings page. The body is a patch: only the keys
// present are validated and written (saveAppConfig's set-only contract keeps
// the other columns untouched). No seed step — app_config falls back to env
// per-field via NULL columns, so a partial row never shadows the other fields.
//
// Per-field rules live in $lib/server/app-config-fields.ts, one table entry
// each. This handler owns only what is actually route-shaped: the auth gate,
// the body parse, dispatching to the table, and the save.

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const patch: AppConfigPatch = {};

	for (const key of APP_CONFIG_FIELD_KEYS) {
		const raw = body[key];
		if (raw === undefined) continue;

		const result = await APP_CONFIG_FIELDS[key](raw, { slack });
		if (!result.ok) {
			return json({ error: result.error }, { status: result.status });
		}
		// The table is keyed by the patch's own field names and each validator is
		// typed to that field's value, so this is sound; TypeScript can't follow
		// the correspondence through a dynamic key.
		(patch as Record<AppConfigFieldKey, unknown>)[key] = result.value;
	}

	if (Object.keys(patch).length === 0) {
		return json({ error: 'no recognized app-config fields in body' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	await saveAppConfig(db, patch, editor);
	return json({ ok: true });
};
