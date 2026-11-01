// VAN's names for a campaign's folders. The catalog stores folder ids only, so
// a page that names folders asks VAN, with the campaign's own key: folder ids
// mean nothing to another campaign's.

import type { VanCampaignRow } from '../schema.js';
import { vanClientFor } from '../van-env.js';

/** Folder id → VAN's name, for every folder the campaign's key can list.
 *  Throws when the campaign has no key or VAN refuses. */
export async function vanFolderNames(
	campaign: Pick<VanCampaignRow, 'credentialKey'>,
): Promise<Map<number, string>> {
	const configured = vanClientFor(campaign);
	if (!configured.ok) throw new Error(configured.error);
	const folders = await configured.client.folders();
	return new Map(folders.map((f) => [f.folderId, f.name]));
}
