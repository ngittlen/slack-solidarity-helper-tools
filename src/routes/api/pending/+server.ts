import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { asc } from 'drizzle-orm';
import { db } from '$lib/server/db.js';
import { requests } from '$lib/server/schema.js';
import { slack } from '$lib/server/slack.js';

const SLACK_EMAIL_CACHE_TTL_MS = 30_000;
let slackEmailCache: { emails: Set<string>; expiresAt: number } | null = null;
let inflight: Promise<Set<string>> | null = null;

export function _resetSlackEmailCache(): void {
	slackEmailCache = null;
	inflight = null;
}

async function getSlackEmails(): Promise<Set<string>> {
	if (slackEmailCache && slackEmailCache.expiresAt > Date.now()) {
		return slackEmailCache.emails;
	}
	if (inflight) return inflight;

	inflight = fetchAllSlackEmails().finally(() => {
		inflight = null;
	});
	return inflight;
}

async function fetchAllSlackEmails(): Promise<Set<string>> {
	const emails = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await slack.users.list({ limit: 200, cursor });
		for (const user of page.members ?? []) {
			if (!user.deleted && !user.is_bot && user.profile?.email) {
				emails.add(user.profile.email.toLowerCase());
			}
		}
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	slackEmailCache = { emails, expiresAt: Date.now() + SLACK_EMAIL_CACHE_TTL_MS };
	return emails;
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) {
		redirect(302, '/auth/slack');
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	const rows = await db
		.select({
			id: requests.id,
			email: requests.email,
			name: requests.name,
			phone: requests.phone,
			comment: requests.comment,
			status: requests.status,
			lastEditedById: requests.lastEditedById,
			lastEditedByName: requests.lastEditedByName,
		})
		.from(requests)
		.orderBy(asc(requests.email));

	if (rows.length === 0) {
		return json({ pending: [], total_requested: 0, total_pending: 0 });
	}

	const slackEmails = await getSlackEmails();

	const pending = rows.map((row) => ({
		...row,
		status: row.status ?? 'uncontacted',
		in_slack: row.email !== null && slackEmails.has(row.email.toLowerCase()),
	}));

	const total_pending = pending.filter((r) => r.status !== 'verified_in_slack').length;

	return json({ pending, total_requested: rows.length, total_pending });
};
