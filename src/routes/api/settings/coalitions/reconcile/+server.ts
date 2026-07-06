import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errMessage } from '$lib/err-message.js';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { loadSettings, type CoalitionEntry } from '$lib/server/settings.js';
import { computeCoalitionDiff } from '$lib/server/coalition-reconcile.js';
import { setUserCustomProperty } from '$lib/server/solidarity.js';

// Coalition reconciliation.
//
// GET  ?group=<internal_name> → the three-way diff between the coalition's
//      Slack channel members and its Solidarity user-list members.
// POST { group, action: 'mark' | 'invite', targets } → apply fixes, returning
//      a per-target outcome so the UI can report partial failures honestly.
//
// The value written when marking is the string "true" — with
// append_custom_user_properties the write is additive, so a coalition whose
// property uses a different truthy convention still ends up matching an
// "is set" list filter.
const MARK_VALUE = 'true';

async function findCoalition(group: string): Promise<CoalitionEntry | undefined> {
	const { coalitionChannelMap } = await loadSettings(db);
	return coalitionChannelMap.find((e) => e.group === group);
}

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	const group = url.searchParams.get('group')?.trim();
	if (!group) {
		return json({ error: 'group is required' }, { status: 400 });
	}
	const entry = await findCoalition(group);
	if (!entry) {
		return json({ error: `Unknown coalition: ${group}` }, { status: 404 });
	}
	if (entry.userListId === null) {
		return json(
			{ error: 'This coalition has no Solidarity user list configured — set one to reconcile.' },
			{ status: 409 },
		);
	}

	try {
		const diff = await computeCoalitionDiff({
			slack,
			token: SOLIDARITY_API_TOKEN,
			channelId: entry.channelId,
			userListId: entry.userListId,
		});
		return json(diff);
	} catch (err) {
		console.error(`[reconcile] diff failed for ${group}:`, errMessage(err));
		return json({ error: `Failed to compute diff: ${errMessage(err)}` }, { status: 502 });
	}
};

interface MarkTarget {
	solidarityUserId?: unknown;
	email?: unknown;
}

interface InviteTarget {
	slackUserId?: unknown;
	email?: unknown;
}

interface ApplyBody {
	group?: unknown;
	action?: unknown;
	targets?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: ApplyBody;
	try {
		body = (await request.json()) as ApplyBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { group, action, targets } = body;
	if (typeof group !== 'string' || group.trim() === '') {
		return json({ error: 'group must be a non-empty string' }, { status: 400 });
	}
	if (action !== 'mark' && action !== 'invite') {
		return json({ error: 'action must be "mark" or "invite"' }, { status: 400 });
	}
	if (!Array.isArray(targets) || targets.length === 0) {
		return json({ error: 'targets must be a non-empty array' }, { status: 400 });
	}

	const entry = await findCoalition(group);
	if (!entry) {
		return json({ error: `Unknown coalition: ${group}` }, { status: 404 });
	}

	const editorId = locals.session.slackUserId;
	const results: { email: string; ok: boolean; error?: string }[] = [];

	if (action === 'mark') {
		for (const raw of targets as MarkTarget[]) {
			const email = typeof raw.email === 'string' ? raw.email : '';
			if (!Number.isInteger(raw.solidarityUserId)) {
				results.push({ email, ok: false, error: 'missing solidarityUserId' });
				continue;
			}
			try {
				await setUserCustomProperty(
					SOLIDARITY_API_TOKEN,
					raw.solidarityUserId as number,
					group,
					MARK_VALUE,
				);
				console.log(
					`[reconcile] marked ${email} (solidarity user ${raw.solidarityUserId}) as ${group} by ${editorId}`,
				);
				results.push({ email, ok: true });
			} catch (err) {
				console.error(`[reconcile] mark failed for ${email}:`, errMessage(err));
				results.push({ email, ok: false, error: errMessage(err) });
			}
		}
	} else {
		for (const raw of targets as InviteTarget[]) {
			const email = typeof raw.email === 'string' ? raw.email : '';
			if (typeof raw.slackUserId !== 'string' || raw.slackUserId === '') {
				results.push({ email, ok: false, error: 'missing slackUserId' });
				continue;
			}
			try {
				await slack.conversations.invite({ channel: entry.channelId, users: raw.slackUserId });
				console.log(
					`[reconcile] invited ${email} (${raw.slackUserId}) to ${entry.channelId} (${group}) by ${editorId}`,
				);
				results.push({ email, ok: true });
			} catch (err) {
				const msg = errMessage(err);
				// Someone who joined between diff and apply is a success, not an error.
				if (msg.includes('already_in_channel')) {
					results.push({ email, ok: true });
				} else {
					console.error(`[reconcile] invite failed for ${email}:`, msg);
					results.push({ email, ok: false, error: msg });
				}
			}
		}
	}

	return json({ results });
};
