import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { slack } from '$lib/server/slack.js';
import { WEBHOOK_SECRET, COALITION_CHANNEL_MAP } from '$lib/server/env.js';

export const GET: RequestHandler = async ({ url }) => {
	if (url.searchParams.get('secret') !== WEBHOOK_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const email = url.searchParams.get('email')?.trim();
	const coalition = url.searchParams.get('coalition')?.trim().toLowerCase();

	if (!email) return json({ error: 'email is required' }, { status: 400 });
	if (!coalition) return json({ error: 'coalition is required' }, { status: 400 });
	if (!email.includes('@')) return json({ error: 'Invalid email address' }, { status: 400 });

	const channelId = COALITION_CHANNEL_MAP[coalition];
	if (!channelId) {
		return json({ error: `Unknown coalition: ${coalition}` }, { status: 400 });
	}

	// Look up the Slack user by email
	let slackUserId: string;
	try {
		const result = await slack.users.lookupByEmail({ email });
		const userId = (result.user as { id?: string } | undefined)?.id;
		if (!userId) {
			return json({ error: `No Slack user found for ${email}` }, { status: 404 });
		}
		slackUserId = userId;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('users_not_found')) {
			return json({ error: `No Slack user found for ${email}` }, { status: 404 });
		}
		console.error(`[coalition-invite] users.lookupByEmail failed for ${email}:`, msg);
		return json({ error: 'Failed to look up Slack user' }, { status: 502 });
	}

	// Invite the user to the coalition channel
	try {
		await slack.conversations.invite({ channel: channelId, users: slackUserId });
		console.log(`[coalition-invite] invited ${email} (${slackUserId}) to ${coalition} (${channelId})`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('already_in_channel')) {
			console.log(`[coalition-invite] ${email} already in ${coalition} (${channelId})`);
			return json({ success: true, already_in_channel: true });
		}
		console.error(`[coalition-invite] failed to invite ${email} to ${coalition}:`, msg);
		return json({ error: 'Failed to invite user to channel' }, { status: 502 });
	}

	return json({ success: true });
};