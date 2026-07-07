import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// Checked here, not just in +layout.server.ts — layout and page loads run
	// concurrently, so an unauthenticated request still reaches this function.
	if (!locals.session?.isAdmin) {
		redirect(302, '/');
	}
	return { userName: locals.session.slackUserName, pageTitle: 'Pending Applicants' };
};
