import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) {
		throw redirect(302, '/auth/slack');
	}

	const result = await db.execute(`
    SELECT id, email, name, phone, comment, status, last_edited_by_id, last_edited_by_name
    FROM requests ORDER BY email ASC
  `);

	if (result.rows.length === 0) {
		return json({ pending: [], total_requested: 0, total_pending: 0 });
	}

	const rows = result.rows.map((r) => ({
		id: r['id'] as number,
		email: (r['email'] as string | null) ?? null,
		name: (r['name'] as string | null) ?? null,
		phone: (r['phone'] as string | null) ?? null,
		comment: (r['comment'] as string | null) ?? null,
		status: (r['status'] as string | null) ?? 'uncontacted',
		lastEditedById: (r['last_edited_by_id'] as string | null) ?? null,
		lastEditedByName: (r['last_edited_by_name'] as string | null) ?? null,
	}));

	// Fetch Slack member emails to check who has already joined
	const slackEmails = new Set<string>();
	let cursor: string | undefined;

	do {
		const page = await slack.users.list({ limit: 200, cursor });
		for (const user of page.members ?? []) {
			if (!user.deleted && !user.is_bot && user.profile?.email) {
				slackEmails.add(user.profile.email.toLowerCase());
			}
		}
		cursor = page.response_metadata?.next_cursor;
	} while (cursor);

	const pending = rows.map((row) => ({
		...row,
		in_slack: row.email !== null && slackEmails.has(row.email.toLowerCase()),
	}));

	const total_pending = pending.filter((r) => r.status !== 'verified_in_slack').length;

	return json({ pending, total_requested: rows.length, total_pending });
}