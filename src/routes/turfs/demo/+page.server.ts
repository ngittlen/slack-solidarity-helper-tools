import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { demoTurfs, DEMO_CHAPTERS, DEMO_LOCATIONS } from './demo-turfs.js';

export const load: PageServerLoad = ({ locals, url }) => {
	// Admin-only, and checked here rather than relying on +layout.server.ts:
	// layout and page loads run concurrently, so an unauthenticated request
	// still reaches this function. Same reasoning as routes/pending.
	//
	// This gate is the demo's only access control and is deliberately stricter
	// than the real feature will be — the shipped /turfs page is open to any
	// logged-in member minus the blocklist. Nothing here touches VAN or the
	// database, so an admin clicking around cannot claim real turf or leak
	// voter data; the data below is fabricated (see demo-turfs.ts).
	if (!locals.session?.isAdmin) {
		redirect(302, '/');
	}

	// Chapter scoping happens on the SERVER, not in the browser. Filtering a
	// full turf list client-side would ship every chapter's data to the page
	// and make the compartment purely cosmetic — the payload is the boundary.
	const requested = Number(url.searchParams.get('chapter'));
	const chapter = DEMO_CHAPTERS.find((c) => c.chapterId === requested) ?? null;

	// Everyone here is an admin, so the demo needs an explicit switch to show
	// what a volunteer sees — otherwise organizers would review the page while
	// looking at strictly more than any volunteer ever will. Defaults to the
	// volunteer view, since that is the flow the page exists to demonstrate.
	//
	// This is not a display toggle: it feeds `visibleTurfState`, so the payload
	// itself differs. Switching to 'admin' is what actually puts holder names
	// on the wire.
	const asAdmin = url.searchParams.get('view') === 'admin';

	return {
		userName: locals.session.slackUserName,
		pageTitle: 'Turf checkout (demo)',
		chapters: DEMO_CHAPTERS,
		chapter,
		asAdmin,
		// No chapter picked yet → no turf data at all, rather than a default
		// chapter's worth. The picker is a real gate, not a pre-filter.
		turfs: chapter ? demoTurfs(chapter.chapterId, { isAdmin: asAdmin }) : [],
		location: chapter ? DEMO_LOCATIONS[chapter.chapterId] : null,
	};
};
