import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { loadSettings } from '$lib/server/settings.js';
import { claimOptionsFor } from '$lib/van/checkout.js';
import { campaignName, loadCampaign } from '$lib/server/van/campaigns.js';
import { vanFolderNames } from '$lib/server/van/folder-names.js';
import { errMessage } from '$lib/err-message.js';
import type { VanCampaignRow } from '$lib/server/schema.js';
import {
	countByFolder,
	releaseAllVanAssignments,
	vanOnlyHeldTurfs,
	type SeenHandOut,
} from '$lib/server/van/turf-van-release-store.js';

// The button under "Sync VAN now" that releases every turf held only by a VAN
// hand-out. Admins only, like that button. The hand-out time limit is the one
// the turf cards apply, so this frees the turf drawn red there, less the
// requested-turf folder's.
//
// GET → what the release would free, counted by VAN folder for the
// confirmation, each turf's hand-out time, and when it was counted. POST →
// release those turf, as long as each is still under the hand-out the GET
// returned: one VAN handed out again in between is someone else's, and stays
// held.

async function organizer(locals: App.Locals) {
	const session = locals.session;
	if (!session) return { response: json({ error: 'Not signed in' }, { status: 401 }) };
	if (!session.isAdmin) return { response: json({ error: 'Organizers only.' }, { status: 403 }) };
	const { vanAssignmentTtlHours } = claimOptionsFor(await loadSettings(db), session);
	return { session, vanAssignmentTtlHours };
}

/** VAN's folder names for one campaign, or none when VAN cannot be asked:
 *  the summary still counts by folder id. */
async function folderNamesOrNone(campaign: VanCampaignRow): Promise<Map<number, string>> {
	try {
		return await vanFolderNames(campaign);
	} catch (err) {
		console.warn(`[van] release summary: campaign ${campaign.id} folders: ${errMessage(err)}`);
		return new Map();
	}
}

export const GET: RequestHandler = async ({ locals }) => {
	const caller = await organizer(locals);
	if (caller.response) return caller.response;
	const countedAt = new Date();
	const turfs = await vanOnlyHeldTurfs(db, countedAt, caller.vanAssignmentTtlHours);
	const campaigns = (
		await Promise.all(
			[...new Set(turfs.map((t) => t.campaignId))].map((id) => loadCampaign(db, id)),
		)
	).filter((c): c is VanCampaignRow => c !== null);
	const names = await Promise.all(
		campaigns.map(async (c) => [c.id, await folderNamesOrNone(c)] as const),
	);
	return json({
		countedAt: countedAt.toISOString(),
		turfs: turfs.map((t) => ({ turfId: t.turfId, since: t.since })),
		folders: countByFolder(
			turfs,
			new Map(names),
			new Map(campaigns.map((c) => [c.id, campaignName(c)])),
		),
	});
};

/** The body a GET's answer makes, or null for anything else. */
function seenSummary(body: unknown): { countedAt: Date; turfs: SeenHandOut[] } | null {
	const { countedAt, turfs } = (body ?? {}) as { countedAt?: unknown; turfs?: unknown };
	if (typeof countedAt !== 'string' || Number.isNaN(Date.parse(countedAt))) return null;
	if (!Array.isArray(turfs)) return null;
	const seen: SeenHandOut[] = [];
	for (const t of turfs as Array<{ turfId?: unknown; since?: unknown }>) {
		if (!Number.isSafeInteger(t?.turfId)) return null;
		if (t.since !== null && typeof t.since !== 'string') return null;
		seen.push({ turfId: t.turfId as number, since: t.since });
	}
	return { countedAt: new Date(countedAt), turfs: seen };
}

export const POST: RequestHandler = async ({ locals, request }) => {
	const caller = await organizer(locals);
	if (caller.response) return caller.response;
	const seen = seenSummary(await request.json().catch(() => null));
	if (!seen) return json({ error: 'Malformed request' }, { status: 400 });
	const released = await releaseAllVanAssignments(
		db,
		seen.turfs,
		seen.countedAt,
		{ id: caller.session.slackUserId, name: caller.session.slackUserName },
		new Date(),
		caller.vanAssignmentTtlHours,
	);
	return json({ released, skipped: seen.turfs.length - released });
};
