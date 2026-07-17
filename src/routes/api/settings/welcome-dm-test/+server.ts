import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { getSlackChannels } from '$lib/server/autocomplete-sources.js';
import { renderWelcomeDm } from '$lib/welcome-dm.js';

// "Send this DM to me" — renders the welcome template and DMs it to the signed-
// in admin so they can proof-read the real thing (links, emoji, formatting)
// before a new member ever sees it. The message can be the unsaved textarea
// value (body.welcomeDmMessage) so testing doesn't require saving first; when
// absent it falls back to the saved setting.
//
// `{{channels}}` is filled with a representative sample of real chapter
// channels (the first couple from the chapter→channel map) so the preview shows
// genuine clickable links rather than a fabricated one; with no map configured
// it falls back to a single literal example.
interface TestBody {
	welcomeDmMessage?: unknown;
}

const SAMPLE_CHANNEL_COUNT = 2;

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

	// Sample channels for {{channels}}: distinct channel ids from the chapter
	// map, capped so the preview stays short.
	const sampleChannelIds = [...new Set(settings.chapterChannelMap.map((e) => e.channelId))].slice(
		0,
		SAMPLE_CHANNEL_COUNT,
	);

	let nameToId = new Map<string, string>();
	try {
		const { items } = await getSlackChannels(slack);
		nameToId = new Map(items.map((c) => [c.name.toLowerCase(), c.id]));
	} catch {
		// Non-fatal: `#name` tokens stay literal in the test message.
	}

	const rendered = renderWelcomeDm(template, sampleChannelIds, nameToId);
	// Signal the sample when there's no real channel to point at, so the admin
	// isn't confused by a missing {{channels}} substitution.
	const text =
		sampleChannelIds.length === 0
			? rendered.replaceAll('{{channels}}', '#your-chapter-channel')
			: rendered;

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