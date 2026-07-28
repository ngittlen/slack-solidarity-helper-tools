import { json, redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db.js';
import { requests } from '$lib/server/schema.js';
import { notifyStatus } from '$lib/server/events.js';

const VALID_STATUSES = ['uncontacted', 'contacted', 'verified_in_slack'] as const;

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) {
		redirect(302, '/auth/slack');
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	const { id, status } = (await request.json()) as { id?: unknown; status?: unknown };
	if (
		typeof id !== 'number' ||
		typeof status !== 'string' ||
		!(VALID_STATUSES as ReadonlyArray<string>).includes(status)
	) {
		error(400, 'Invalid request body');
	}

	const editorName = locals.session.slackUserName ?? locals.session.slackUserId;

	await db
		.update(requests)
		.set({ status, lastEditedById: locals.session.slackUserId, lastEditedByName: editorName })
		.where(eq(requests.id, id));

	notifyStatus(id, status, editorName);

	return json({ success: true });
};
