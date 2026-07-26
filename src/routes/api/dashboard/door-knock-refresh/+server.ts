import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { runDoorKnockSnapshot } from '$lib/server/door-knock-snapshot.js';
import { refreshDoorKnockIfStale } from '$lib/server/door-knock-refresh.js';
import { doorKnockSnapshotDeps } from '$lib/server/door-knock-env.js';

// Called by the dashboard when its door-knock numbers are older than the
// refresh window, so visitors close to election day see near-live totals
// instead of last night's snapshot. Signed-in members only (no admin gate —
// same audience as the chart itself); the throttling that protects Openfield
// lives in refreshDoorKnockIfStale, not here.
//
// Deliberately quieter than the scheduled snapshot at
// /api/internal/door-knock-snapshot: no Slack canvas-drift alarm, since that
// alarm is a nightly signal for a human and would otherwise fire on every
// page visit. The scheduled run still raises it.
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const config = doorKnockSnapshotDeps();
	if (!config.ok) {
		// Not an error for the caller — the integration just isn't set up. The
		// dashboard hides the card in that case anyway.
		return json({ status: 'unconfigured' });
	}

	const outcome = await refreshDoorKnockIfStale(db, () =>
		runDoorKnockSnapshot(db, config.deps),
	);
	// A failed refresh still returns 200: the page has valid (if older) data to
	// show, and the client's job is the same either way — stop the spinner and
	// reload whatever the server now has.
	return json({ status: outcome.status });
};
