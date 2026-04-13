import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { WEBHOOK_SECRET, SLACK_TRACKING_CHANNEL_ID, APP_URL } from '$lib/server/env.js';
import { notifyNewRequest } from '$lib/server/events.js';

export const GET: RequestHandler = async ({ url }) => {
	if (url.searchParams.get('secret') !== WEBHOOK_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const email = url.searchParams.get('email');
	const name = url.searchParams.get('name');
	const phone = url.searchParams.get('phone');

	const trimmedEmail = typeof email === 'string' ? email.trim() || null : null;
	const trimmedName = typeof name === 'string' ? name.trim() || null : null;
	const trimmedPhone = typeof phone === 'string' ? phone.trim() || null : null;

	if (!trimmedEmail && !trimmedPhone) {
		return json({ error: 'At least one of email or phone is required' }, { status: 400 });
	}

	if (trimmedEmail && !trimmedEmail.includes('@')) {
		return json({ error: 'Invalid email address' }, { status: 400 });
	}

	const existing = await db.execute({
		sql: `SELECT id FROM requests
		      WHERE (email IS NULL AND ? IS NULL OR email = ?)
		        AND (phone IS NULL AND ? IS NULL OR phone = ?)
		      LIMIT 1`,
		args: [trimmedEmail, trimmedEmail, trimmedPhone, trimmedPhone],
	});

	if (existing.rows.length > 0) {
		const id = Number(existing.rows[0]!['id']);
		await db.execute({
			sql: 'UPDATE requests SET name = ?, requested_at = ? WHERE id = ?',
			args: [trimmedName, new Date().toISOString(), id],
		});
		return json({ success: true, email: trimmedEmail, phone: trimmedPhone });
	}

	const result = await db.execute({
		sql: 'INSERT INTO requests (email, name, phone, requested_at) VALUES (?, ?, ?, ?)',
		args: [trimmedEmail, trimmedName, trimmedPhone, new Date().toISOString()],
	});

	notifyNewRequest({
		id: Number(result.lastInsertRowid),
		email: trimmedEmail,
		name: trimmedName,
		phone: trimmedPhone,
	});

	const details = [
		trimmedName,
		trimmedPhone ? `📞 ${trimmedPhone}` : null,
		trimmedEmail ? `\`${trimmedEmail}\`` : null,
	]
		.filter(Boolean)
		.join('  ·  ');

	if ((env as Record<string, string | undefined>)['DEV_SLACK_USER_ID']) {
		console.log(`[webhook] dev mode — would post to Slack: ${details}`);
	} else {
		try {
			await slack.chat.postMessage({
				channel: SLACK_TRACKING_CHANNEL_ID,
				text: `Volunteer needs help joining Slack: ${trimmedEmail ?? trimmedPhone}`,
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `:wave: A volunteer needs help joining Slack: ${details}\n<${APP_URL}/pending|View pending invites>`,
						},
					},
				],
			});
			console.log(`[webhook] posted to channel for ${trimmedEmail ?? trimmedPhone}`);
		} catch (err) {
			console.error(`[webhook] failed to post for ${trimmedEmail ?? trimmedPhone}:`, err instanceof Error ? err.message : err);
			return json({ error: 'Failed to post to Slack' }, { status: 502 });
		}
	}

	return json({ success: true, email: trimmedEmail, phone: trimmedPhone });
}