import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings, type ChapterEntry } from '$lib/server/settings.js';
import { getUserByEmail } from '$lib/server/solidarity.js';
import { getSlackChannels } from '$lib/server/autocomplete-sources.js';
import { DEFAULT_WELCOME_DM, renderWelcomeDm, resolveChannelLinks } from '$lib/welcome-dm.js';

// "Send this DM to me" — renders the welcome template and DMs it to the signed-
// in admin so they can proof-read the real thing (links, emoji, formatting)
// before a new member ever sees it. The message can be the unsaved textarea
// value (body.welcomeDmMessage) so testing doesn't require saving first; when
// absent it falls back to the saved setting.
//
// `{{channels}}` is filled with the ADMIN's own chapter channels — resolved the
// same way the real join flow does (Slack id → email → Solidarity chapters →
// channel map) — so the preview matches what they'd actually receive. When the
// admin isn't a mapped Solidarity member it falls back to a labeled placeholder
// so the substitution is never silently empty.
interface TestBody {
	welcomeDmMessage?: unknown;
}

const NO_CHANNELS_PLACEHOLDER = '#your-chapter-channel(s)';

/** The admin's own chapter channels (deduped), or [] when their Slack account
 *  can't be mapped to a Solidarity member with mapped chapters. Never throws —
 *  a lookup failure just yields the placeholder preview. */
async function resolveOwnChannelIds(
	slackUserId: string,
	chapterChannelMap: ChapterEntry[],
): Promise<string[]> {
	try {
		const info = await slack.users.info({ user: slackUserId });
		const email = (info.user as { profile?: { email?: string } } | undefined)?.profile?.email;
		if (!email) return [];
		const solidarityUser = await getUserByEmail(email);
		if (!solidarityUser) return [];
		const chapterIds = solidarityUser.chapter_ids?.length
			? solidarityUser.chapter_ids
			: solidarityUser.chapter_id != null
				? [solidarityUser.chapter_id]
				: [];
		if (chapterIds.length === 0) return [];
		return [
			...new Set(
				chapterChannelMap
					.filter((e) => chapterIds.includes(e.chapterId))
					.map((e) => e.channelId),
			),
		];
	} catch {
		return [];
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: TestBody;
	try {
		body = (await request.json()) as TestBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	if (body.welcomeDmMessage !== undefined && typeof body.welcomeDmMessage !== 'string') {
		return json({ error: 'welcomeDmMessage must be a string' }, { status: 400 });
	}

	const settings = await loadSettings(db);
	const template = body.welcomeDmMessage ?? settings.welcomeDmMessage;

	const ownChannelIds = await resolveOwnChannelIds(
		locals.session.slackUserId,
		settings.chapterChannelMap,
	);

	let nameToId = new Map<string, string>();
	try {
		const { items } = await getSlackChannels(slack);
		nameToId = new Map(items.map((c) => [c.name.toLowerCase(), c.id]));
	} catch {
		// Non-fatal: `#name` tokens stay literal in the test message.
	}

	// With real channels, render exactly as the join flow would. Without them,
	// fill {{channels}} with a labeled placeholder (still resolving #name links
	// and the blank-template default) so the preview is honest, not empty.
	const text =
		ownChannelIds.length > 0
			? renderWelcomeDm(template, ownChannelIds, nameToId)
			: resolveChannelLinks(
					(template.trim() || DEFAULT_WELCOME_DM).replaceAll(
						'{{channels}}',
						NO_CHANNELS_PLACEHOLDER,
					),
					nameToId,
				);

	try {
		const dm = await slack.conversations.open({ users: locals.session.slackUserId });
		const dmChannelId = (dm as { channel?: { id?: string } }).channel?.id;
		if (!dmChannelId) {
			return json({ error: 'Could not open a DM channel with you.' }, { status: 502 });
		}
		await slack.chat.postMessage({
			channel: dmChannelId,
			text: `:test_tube: *Welcome DM preview*\n${text}`,
			blocks: [
				{
					type: 'context',
					elements: [{ type: 'mrkdwn', text: ':test_tube: Welcome DM preview — this is a test' }],
				},
				{ type: 'section', text: { type: 'mrkdwn', text } },
			],
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[settings] welcome-dm test send failed:', msg);
		return json({ error: `Slack rejected the test send: ${msg}` }, { status: 502 });
	}

	console.log(
		`[settings] sent welcome-DM test to ${locals.session.slackUserId} (${locals.session.slackUserName ?? '?'})`,
	);
	return json({ ok: true });
};