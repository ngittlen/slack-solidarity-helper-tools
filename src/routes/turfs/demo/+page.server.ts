import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The demo used to be a page of its own, with its own copy of the layout, its
// own claim handling, and its own copy of the turf shape. All three drifted
// from the real page, which defeats the point of having a walkthrough at all.
// It is now a mode of /turfs (admin-only, `?demo`), so there is one page to
// keep working.
//
// This stub survives because organizers were given the old link while the VAN
// security review ran, and a 404 for them is worse than three lines here.
export const load: PageServerLoad = ({ url }) => {
	const chapter = url.searchParams.get('chapter');
	redirect(308, `/turfs?demo${chapter ? `&chapter=${encodeURIComponent(chapter)}` : ''}`);
};
