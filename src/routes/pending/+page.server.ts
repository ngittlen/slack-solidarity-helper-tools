import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.session) {
		redirect(302, '/auth/slack');
	}
	return { userName: locals.session.slackUserName };
}