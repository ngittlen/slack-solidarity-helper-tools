import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';
import { secretMatches } from '$lib/server/secret-compare.js';
import { purgeExpiredPhones } from '$lib/server/mentor-walks/store.js';

// Mentor walk housekeeping, called hourly by the in-process scheduler: deletes
// each walk's phone number a day after its start (specs/015-mentor-walks,
// FR-011). Auth via ?key=<INTERNAL_CRON_SECRET>. One UPDATE, idempotent, so
// it needs no lock.
export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[mentor-walks] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	try {
		const phonesDeleted = await purgeExpiredPhones(db, new Date());
		return json({ ok: true, phonesDeleted });
	} catch (err) {
		console.error('[mentor-walks] sweep failed:', err);
		return json({ error: 'Sweep failed' }, { status: 500 });
	}
};
