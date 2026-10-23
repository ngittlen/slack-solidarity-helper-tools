import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { manualSyncView } from '../manual-sync-view.js';

// GET → the latest "Sync VAN now" press, as the organizer page shows it.
// Polled by the page while a press runs, so the organizer watches it through
// and sees what it picked up without reloading the whole board.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) return json({ error: 'unauthenticated' }, { status: 401 });
	if (!locals.session.isAdmin) return json({ error: 'unauthorized' }, { status: 403 });
	return json({ sync: await manualSyncView(new Date()) });
};
