import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { sheetsServiceAccountEmail } from '$lib/server/google-env.js';
import { loadVanChapterFolders, loadVanSheetTargets } from '$lib/server/settings.js';
import { credentialStatus } from '$lib/server/van-env.js';
import { campaignName, loadCampaign } from '$lib/server/van/campaigns.js';
import { loadCampaignStatus } from '$lib/server/van/campaign-status-store.js';
import { getSolidarityChapters } from '$lib/server/autocomplete-sources.js';
import { errMessage } from '$lib/err-message.js';
import { campaignChip } from '$lib/van/campaign-list.js';

// One VAN campaign's settings page (specs/012-multi-van-campaigns, Phase 5).
//
// Admin-only, with the same bare 302 as /settings. Everything about the
// campaign that is not a credential is edited here; its credentials are only
// described, through credentialStatus, which never carries the key — so no
// field of this page's data can leak it.

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.session?.isAdmin) redirect(302, '/');

	const id = Number(params.campaignId);
	const campaign = Number.isInteger(id) && id > 0 ? await loadCampaign(db, id) : null;
	if (!campaign) error(404, 'No such campaign');

	const [status, mappings, targets, chapters] = await Promise.all([
		loadCampaignStatus(db, campaign.id, new Date()),
		loadVanChapterFolders(db, campaign.id),
		loadVanSheetTargets(db, campaign.id),
		// The folder editor's chapter picker. Not page-fatal: without it the
		// rest of the page still answers what it is for.
		getSolidarityChapters(SOLIDARITY_API_TOKEN).then(
			(result) => ({ ok: true as const, items: result.items }),
			(err: unknown) => ({ ok: false as const, error: errMessage(err) }),
		),
	]);

	const name = campaignName(campaign);
	return {
		pageTitle: `${name} · VAN campaign`,
		campaign: {
			id: campaign.id,
			name,
			label: campaign.label ?? '',
			badgeLabel: campaign.badgeLabel ?? '',
			credentialKey: campaign.credentialKey,
			enabled: campaign.enabled,
			chip: campaignChip(campaign),
			disabledAt: campaign.disabledAt,
			disabledByName: campaign.disabledByName,
			exportJobTypeId: campaign.exportJobTypeId,
			refreshEnabled: campaign.refreshEnabled,
			sheetsEnabled: campaign.sheetsEnabled,
			sheetTabName: campaign.sheetTabName ?? '',
		},
		credentials: credentialStatus(campaign),
		status,
		mappings,
		targets,
		chapters: chapters.ok ? chapters.items : null,
		chaptersError: chapters.ok ? null : chapters.error,
		sheetsServiceAccountEmail: sheetsServiceAccountEmail(),
	};
};
