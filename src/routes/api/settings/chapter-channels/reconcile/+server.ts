import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errMessage } from '$lib/err-message.js';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { loadSettings } from '$lib/server/settings.js';
import { computeChapterMovePlan } from '$lib/server/chapter-reconcile.js';

// Chapter reconciliation ("move members into mapped channels").
//
// GET  → the full move plan: per mapped channel, everyone whose Solidarity
//        chapters map there but who isn't a member yet, plus report-only
//        counts. Invite-only — the plan never proposes removals.
// POST { targets: [{ channelId, slackUserId, email }] } → apply the invites
//        the admin confirmed in the modal, returning a per-target outcome so
//        the UI can report partial failures honestly.
//
// Invites are batched per channel (conversations.invite accepts up to 1000
// comma-separated user ids and applies them partially, reporting per-user
// failures in an `errors` array) — a serial per-person loop would take
// minutes at workspace scale.

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	const { chapterChannelMap } = await loadSettings(db);
	if (chapterChannelMap.length === 0) {
		return json(
			{ error: 'No chapter ↔ channel mappings configured — nothing to move anyone into.' },
			{ status: 409 },
		);
	}

	try {
		const plan = await computeChapterMovePlan({
			slack,
			token: SOLIDARITY_API_TOKEN,
			entries: chapterChannelMap,
		});
		return json(plan);
	} catch (err) {
		console.error('[chapter-reconcile] plan failed:', errMessage(err));
		return json({ error: `Failed to compute move plan: ${errMessage(err)}` }, { status: 502 });
	}
};

interface MoveTarget {
	channelId?: unknown;
	slackUserId?: unknown;
	email?: unknown;
}

interface ApplyBody {
	targets?: unknown;
}

export interface MoveResult {
	channelId: string;
	slackUserId: string;
	email: string;
	ok: boolean;
	error?: string;
}

const INVITE_CHUNK_SIZE = 200;

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

	const { targets } = body;
	if (!Array.isArray(targets) || targets.length === 0) {
		return json({ error: 'targets must be a non-empty array' }, { status: 400 });
	}
	for (const raw of targets as MoveTarget[]) {
		if (
			typeof raw.channelId !== 'string' ||
			raw.channelId === '' ||
			typeof raw.slackUserId !== 'string' ||
			raw.slackUserId === ''
		) {
			return json({ error: 'every target needs channelId and slackUserId' }, { status: 400 });
		}
	}

	// Only channels the settings actually map are invitable through this
	// endpoint — it must not be a generic invite-anyone-anywhere API.
	const { chapterChannelMap } = await loadSettings(db);
	const mappedChannelIds = new Set(chapterChannelMap.map((e) => e.channelId));

	const editorId = locals.session.slackUserId;
	const results: MoveResult[] = [];

	// Group by channel, dedupe users within each.
	const byChannel = new Map<string, { slackUserId: string; email: string }[]>();
	for (const raw of targets as { channelId: string; slackUserId: string; email?: unknown }[]) {
		const email = typeof raw.email === 'string' ? raw.email : '';
		if (!mappedChannelIds.has(raw.channelId)) {
			results.push({
				channelId: raw.channelId,
				slackUserId: raw.slackUserId,
				email,
				ok: false,
				error: 'channel is not in the chapter ↔ channel map',
			});
			continue;
		}
		const list = byChannel.get(raw.channelId) ?? [];
		if (!list.some((t) => t.slackUserId === raw.slackUserId)) {
			list.push({ slackUserId: raw.slackUserId, email });
		}
		byChannel.set(raw.channelId, list);
	}

	for (const [channelId, users] of byChannel) {
		for (let i = 0; i < users.length; i += INVITE_CHUNK_SIZE) {
			const chunk = users.slice(i, i + INVITE_CHUNK_SIZE);
			try {
				await slack.conversations.invite({
					channel: channelId,
					users: chunk.map((u) => u.slackUserId).join(','),
				});
				for (const u of chunk) results.push({ channelId, ...u, ok: true });
			} catch (err) {
				// Multi-user invites apply partially: Slack invites whoever it can
				// and reports the rest in a per-user `errors` array on the error
				// payload. Someone who joined between plan and apply
				// (already_in_channel) is a success, not a failure.
				const data = (err as { data?: { errors?: { user?: string; error?: string }[] } }).data;
				const perUser = new Map(
					(data?.errors ?? []).map((e) => [e.user ?? '', e.error ?? 'unknown_error']),
				);
				const wholesale = perUser.size === 0;
				const msg = errMessage(err);
				for (const u of chunk) {
					const userError = wholesale ? msg : perUser.get(u.slackUserId);
					if (userError === undefined || userError.includes('already_in_channel')) {
						results.push({ channelId, ...u, ok: true });
					} else {
						results.push({ channelId, ...u, ok: false, error: userError });
					}
				}
			}
		}
	}

	const okCount = results.filter((r) => r.ok).length;
	console.log(
		`[chapter-reconcile] applied ${okCount}/${results.length} invites across ${byChannel.size} channels by ${editorId}`,
	);
	return json({ results });
};
