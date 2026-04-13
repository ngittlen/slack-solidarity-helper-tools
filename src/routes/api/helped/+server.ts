import { json, redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { notifyStatus } from '$lib/server/events.js';

const VALID_STATUSES = ['uncontacted', 'contacted', 'verified_in_slack'] as const;

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) {
		redirect(302, '/auth/slack');
	}

	const body = await request.json();
	if (typeof body.id !== 'number' || !(VALID_STATUSES as ReadonlyArray<string>).includes(body.status)) {
		error(400, 'Invalid request body');
	}

	const editorName = locals.session!.slackUserName ?? locals.session!.slackUserId;

	await db.execute({
		sql: 'UPDATE requests SET status = ?, last_edited_by_id = ?, last_edited_by_name = ? WHERE id = ?',
		args: [body.status, locals.session!.slackUserId, editorName, body.id],
	});

	notifyStatus(body.id, body.status, editorName);

	return json({ success: true });
};