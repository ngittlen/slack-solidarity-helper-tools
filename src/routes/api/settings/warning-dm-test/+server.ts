import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { getSlackChannels } from '$lib/server/autocomplete-sources.js';
import { renderWarningDm } from '$lib/warning-dm.js';

// "Send this warning DM to me" on /settings. Renders the draft template with
// sample values and DMs it to the signed-in admin, so they can see the real
// thing in Slack before it is ever sent to a member. Mirrors welcome-dm-test.

interface TestBody {
	warningDmMessage?: unknown;
}

// Deliberately 2 rather than 1: it exercises the ordinal (an admin previewing
// "first" learns nothing about whether {{nth}} works) and reads like a real
// escalation.
const SAMPLE_WARNING_NUMBER = 2;
const SAMPLE_NOTE = 'Example: kept posting off-topic links in #general after being asked to stop.';
// A plausible-looking permalink for the {{message_link}} slot. Not a real
// message — this is a preview, and pointing at an arbitrary real message would
// be more confusing than a clearly fake one.
const SAMPLE_MESSAGE_LINK = 'https://slack.com/archives/C0EXAMPLE/p1712345678123456';

const PREVIEW_NOTE =
	':test_tube: Warning DM preview — sample values for {{nth}}, {{note}} and {{message_link}}';

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
	if (body.warningDmMessage !== undefined && typeof body.warningDmMessage !== 'string') {
		return json({ error: 'warningDmMessage must be a string' }, { status: 400 });
	}

	// Prefer the unsaved draft so an admin can preview before committing;
	// fall back to what's stored.
	const template = body.warningDmMessage ?? (await loadSettings(db)).warningDmMessage;

	let nameToId = new Map<string, string>();
	try {
		const { items } = await getSlackChannels(slack);
		nameToId = new Map(items.map((c) => [c.name.toLowerCase(), c.id]));
	} catch {
		// Non-fatal: `#name` tokens stay literal in the preview.
	}

	const text = renderWarningDm(
		template,
		{
			warningNumber: SAMPLE_WARNING_NUMBER,
			noteBody: SAMPLE_NOTE,
			messageLink: SAMPLE_MESSAGE_LINK,
		},
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
			text: `${PREVIEW_NOTE}\n${text}`,
			blocks: [
				{ type: 'context', elements: [{ type: 'mrkdwn', text: PREVIEW_NOTE }] },
				{ type: 'section', text: { type: 'mrkdwn', text } },
			],
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[settings] warning-dm test send failed:', msg);
		return json({ error: `Slack rejected the test send: ${msg}` }, { status: 502 });
	}

	console.log(
		`[settings] sent warning-DM test to ${locals.session.slackUserId} (${locals.session.slackUserName ?? '?'})`,
	);
	return json({ ok: true });
};
