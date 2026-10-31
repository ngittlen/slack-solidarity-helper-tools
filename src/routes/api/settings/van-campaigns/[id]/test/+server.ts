import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { vanClientFor } from '$lib/server/van-env.js';
import { loadCampaign } from '$lib/server/van/campaigns.js';
import { VanError } from '$lib/server/van/client.js';
import { errMessage } from '$lib/err-message.js';

// "Test connection" on a campaign's settings page: the two reads that say
// whether its key works, done server-side with the campaign's own key.
//
// /folders proves the credentials and lists what the key can see — the ids an
// admin types into the folder mapping. /exportJobTypes lists what this key can
// export, which is where the export job type is picked from; the ids are per
// developer, so the 5 on one key may be nothing on another.
//
// Read-only, admin-only, and nothing in the response comes from the secret.

/** A VAN failure as an admin needs to read it. */
function describe(err: unknown): string {
	if (err instanceof VanError) {
		if (err.status === 401) return 'credentials rejected — check the appName and key in the secret';
		if (err.status === 403) return 'not granted to this key — ask EveryAction for this tier';
	}
	return errMessage(err);
}

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.session) return json({ error: 'unauthenticated' }, { status: 401 });
	if (!locals.session.isAdmin) return json({ error: 'unauthorized' }, { status: 403 });

	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'campaign id must be a positive integer' }, { status: 400 });
	}
	const campaign = await loadCampaign(db, id);
	if (!campaign) return json({ error: `No campaign ${id}` }, { status: 404 });

	const configured = vanClientFor(campaign);
	if (!configured.ok) {
		return json({ ok: false, folders: null, exportJobTypes: null, errors: [configured.error] });
	}
	const client = configured.client;

	const errors: string[] = [];
	let folders: Array<{ folderId: number; name: string }> | null = null;
	let exportJobTypes: Array<{ exportJobTypeId: number; name: string }> | null = null;
	// One after the other: the client caps concurrency anyway, and a key VAN
	// rejects is rejected by the first call.
	try {
		folders = (await client.folders())
			.map((f) => ({ folderId: f.folderId, name: f.name ?? '' }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch (err) {
		errors.push(`Folders: ${describe(err)}`);
	}
	try {
		exportJobTypes = (await client.exportJobTypes()).map((t) => ({
			exportJobTypeId: t.exportJobTypeId,
			name: t.name ?? '',
		}));
	} catch (err) {
		errors.push(`Export job types: ${describe(err)}`);
	}

	console.log(
		`[van] connection test for campaign ${id} (${campaign.credentialKey}) by ${locals.session.slackUserId}: ` +
			(errors.length === 0 ? 'ok' : errors.join('; ')),
	);
	return json({ ok: folders !== null, folders, exportJobTypes, errors });
};
