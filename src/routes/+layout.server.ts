import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { loadSettings } from '$lib/server/settings.js';
import { errMessage } from '$lib/err-message.js';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.session) {
		redirect(302, '/auth/slack');
	}

	// Header countdown config. A settings-read failure hides the countdown
	// rather than 500ing every page — the layout wraps the whole app.
	let countdown: { label: string; endAt: string } | null = null;
	try {
		const { countdownLabel, countdownEndAt } = await loadSettings(db);
		if (countdownEndAt !== '') {
			countdown = { label: countdownLabel, endAt: countdownEndAt };
		}
	} catch (err) {
		console.error('[layout] loadSettings failed — hiding countdown:', errMessage(err));
	}

	return {
		userName: locals.session.slackUserName,
		isAdmin: locals.session.isAdmin,
		countdown
	};
};