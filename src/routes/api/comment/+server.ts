import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db.js';
import { requests } from '$lib/server/schema.js';
import { notifyComment } from '$lib/server/events.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		redirect(302, '/auth/slack');
	}

	const { id, comment } = (await request.json()) as { id?: unknown; comment?: unknown };
	if (typeof id !== 'number' || typeof comment !== 'string') {
		return json({ error: 'id (number) and comment (string) are required' }, { status: 400 });
	}

	const trimmedComment = comment.trim() || null;
	const editorName = locals.session.slackUserName ?? locals.session.slackUserId;

	await db
		.update(requests)
		.set({ comment: trimmedComment, lastEditedById: locals.session.slackUserId, lastEditedByName: editorName })
		.where(eq(requests.id, id));

	notifyComment(id, trimmedComment, editorName);

	return json({ success: true });
}
