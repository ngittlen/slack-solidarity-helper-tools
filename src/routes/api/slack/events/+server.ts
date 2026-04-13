import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { slack } from '$lib/server/slack.js';
import { getUserByEmail } from '$lib/server/solidarity.js';
import { SLACK_SIGNING_SECRET, SOLIDARITY_CHAPTER_CHANNEL_MAP } from '$lib/server/env.js';

// ---------------------------------------------------------------------------
// Slack signature verification
// ---------------------------------------------------------------------------

export async function _verifySlackSignature(request: Request, body: string): Promise<boolean> {
	if (!SLACK_SIGNING_SECRET) {
		console.error('[slack-events] SLACK_SIGNING_SECRET is not set');
		return false;
	}
	const signature = request.headers.get('x-slack-signature');
	const timestamp = request.headers.get('x-slack-request-timestamp');
	if (!signature || !timestamp) return false;

	// Reject requests older than 5 minutes to prevent replay attacks
	if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;

	const sigBasestring = `v0:${timestamp}:${body}`;
	const computed = `v0=${createHmac('sha256', SLACK_SIGNING_SECRET).update(sigBasestring).digest('hex')}`;

	if (computed.length !== signature.length) return false;
	return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.text();

	if (!(await _verifySlackSignature(request, body))) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const payload = JSON.parse(body) as SlackEventPayload;

	// Slack sends this once when you first configure the Events API URL
	if (payload.type === 'url_verification') {
		return json({ challenge: payload.challenge });
	}

	if (payload.type === 'event_callback' && payload.event?.type === 'team_join') {
		// Respond immediately — Slack requires a 200 within 3 seconds
		handleTeamJoin(payload.event.user).catch((err) => {
			console.error(
				'[slack-events] team_join handler failed:',
				err instanceof Error ? err.message : err,
			);
		});
	}

	return json({ ok: true });
};

// ---------------------------------------------------------------------------
// team_join handler
// ---------------------------------------------------------------------------

interface SlackUser {
	id: string;
	profile?: { email?: string };
}

interface SlackEventPayload {
	type: string;
	challenge?: string;
	event?: { type: string; user: SlackUser };
}

async function handleTeamJoin(user: SlackUser): Promise<void> {
	const email = user.profile?.email;
	if (!email) {
		console.log(`[slack-events] team_join for ${user.id} — no email on profile, skipping`);
		return;
	}

	const solidarityUser = await getUserByEmail(email);
	if (!solidarityUser) {
		console.log(`[slack-events] no solidarity account found for ${email}`);
		return;
	}

	const chapterIds: number[] =
		solidarityUser.chapter_ids?.length
			? solidarityUser.chapter_ids
			: solidarityUser.chapter_id != null
				? [solidarityUser.chapter_id]
				: [];

	const channelIds = chapterIds
		.map((id) => SOLIDARITY_CHAPTER_CHANNEL_MAP[String(id)])
		.filter((id): id is string => Boolean(id));

	if (!channelIds.length) {
		console.log(
			`[slack-events] no channel mapping for chapters [${chapterIds.join(', ')}] (${email})`,
		);
		return;
	}

	// Invite the user to each county channel, then DM them
	const inviteResults = await Promise.allSettled(
		channelIds.map((channelId) =>
			slack.conversations.invite({ channel: channelId, users: user.id }),
		),
	);

	const successfulChannelIds: string[] = [];
	for (let i = 0; i < channelIds.length; i++) {
		const result = inviteResults[i]!;
		if (result.status === 'fulfilled') {
			successfulChannelIds.push(channelIds[i]!);
		} else {
			console.error(
				`[slack-events] failed to invite ${user.id} to ${channelIds[i]}:`,
				result.reason instanceof Error ? result.reason.message : result.reason,
			);
		}
	}

	const channelMentions = successfulChannelIds.map((id) => `<#${id}>`).join(', ');
	if (!channelMentions) {
		console.log(`[slack-events] all channel invites failed for ${user.id} (${email}), skipping DM`);
		return;
	}

	const dm = await slack.conversations.open({ users: user.id });
	const dmChannelId = (dm as { channel?: { id?: string } }).channel?.id;
	if (!dmChannelId) {
		console.error(`[slack-events] failed to open DM channel with ${user.id}`);
		return;
	}

	const channelText =
		successfulChannelIds.length === 1
			? `your county chapter channel: ${channelMentions}`
			: `your county chapter channels: ${channelMentions}`;

	await slack.chat.postMessage({
		channel: dmChannelId,
		text: `Welcome! We've added you to ${channelText}.`,
		blocks: [
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `:wave: Welcome to the volunteer slack! We've added you to ${channelText} based on your zip code. Feel free to introduce yourself there!`,
				},
			},
		],
	});

	console.log(`[slack-events] invited ${user.id} (${email}) to ${channelMentions} and sent DM`);
}