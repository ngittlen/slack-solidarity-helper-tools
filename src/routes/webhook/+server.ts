import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db.js';
import { requests } from '$lib/server/schema.js';
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

	// Dedup strategy: prefer email match, fall back to phone. Email is the
	// primary identifier (UNIQUE in the schema); phone is a secondary lookup
	// for callers who only have a phone number. We never merge across the two
	// — if email matches one row and phone matches a different row, the email
	// row wins and the phone row is left untouched.
	let existing: { id: number }[] = [];
	if (trimmedEmail !== null) {
		existing = await db
			.select({ id: requests.id })
			.from(requests)
			.where(eq(requests.email, trimmedEmail))
			.limit(1);
	}
	if (existing.length === 0 && trimmedPhone !== null) {
		existing = await db
			.select({ id: requests.id })
			.from(requests)
			.where(eq(requests.phone, trimmedPhone))
			.limit(1);
	}

	if (existing.length > 0) {
		const id = existing[0]!.id;
		await db
			.update(requests)
			.set({
				requestedAt: new Date().toISOString(),
				...(trimmedName !== null && { name: trimmedName }),
			})
			.where(eq(requests.id, id));
		return json({ success: true, email: trimmedEmail, phone: trimmedPhone });
	}

	const result = await db
		.insert(requests)
		.values({ email: trimmedEmail, name: trimmedName, phone: trimmedPhone, requestedAt: new Date().toISOString() })
		.returning({ id: requests.id });

	const newId = result[0]!.id;

	notifyNewRequest({
		id: newId,
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
							text: `:wave: A volunteer needs help joining Slack: ${details}\n<${APP_URL}/pending|View pending requests>`,
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
