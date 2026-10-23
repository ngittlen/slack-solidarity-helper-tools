// The latest "Sync VAN now" press as /turfs/organizer shows it: where it has
// got to, what kept turf back, and the requested turf it picked up with what
// each still waits on. Shared by the page's load and the poll the page runs
// while a press is under way (sync-status/+server.ts), so both say the same.
//
// Sentences are built here rather than in the component: they need the
// server's clock, as every "ago" on this page does (see +page.svelte).

import { db } from '$lib/server/db.js';
import { relativeSince } from '$lib/components/settings/format-relative.js';
import { latestManualVanSync } from '$lib/server/van/manual-sync.js';
import type { CampaignDrain } from '$lib/server/van/manual-geometry.js';
import type { CampaignPassReport, ManualSyncRun } from '$lib/server/van/manual-sync-report.js';
import {
	loadRequestedTurf,
	requestedTurfCaveats,
	requestedTurfLabel,
} from '$lib/server/van/turf-placement.js';

/** How long after it finishes a press is still shown in place of "VAN last
 *  synced": long enough for an organizer who wandered off to come back to it. */
const SHOWN_FOR_MS = 2 * 60 * 60 * 1000;
/** New turf listed in the report; the Requested turf table has the rest. */
const NEW_TURF_SHOWN = 20;

export interface ManualSyncNote {
	text: string;
	/** Something an organizer has to fix, rather than wait out. */
	error: boolean;
	/** The campaign's settings, where the fix is. */
	campaignId?: number;
}

export interface ManualSyncView {
	/** Still going: the page polls until it is not. */
	running: boolean;
	/** The headline: where it is, or how it ended. */
	status: string;
	stalled: boolean;
	/** What kept turf back, campaign by campaign. Empty when nothing did. */
	notes: ManualSyncNote[];
	/** Requested turf first read by this press, newest first. */
	newTurf: Array<{
		turfId: number;
		name: string;
		regionName: string;
		label: string;
		caveats: string[];
		/** On volunteers' maps: placed somewhere, and nothing stops a claim. */
		ready: boolean;
	}>;
	newTurfTotal: number;
}

export async function manualSyncView(now: Date): Promise<ManualSyncView | null> {
	const run = await latestManualVanSync(db);
	if (!run) return null;
	if (run.finishedAt && now.getTime() - Date.parse(run.finishedAt) > SHOWN_FOR_MS) return null;
	if (run.stalled && now.getTime() - Date.parse(run.startedAt) > SHOWN_FOR_MS) return null;

	// What is in the folder now and was not when it was pressed. A record
	// with no list falls back to when each turf was first read, which misses
	// turf moved into the folder.
	const found = await loadRequestedTurf(
		db,
		NEW_TURF_SHOWN,
		run.requestedTurfIds
			? { excludeTurfIds: run.requestedTurfIds }
			: { firstSeenSince: run.startedAt },
	);
	const newTurf = found.turfs.map((t) => {
		const caveats = requestedTurfCaveats(t);
		return {
			turfId: t.turfId,
			name: t.name,
			regionName: t.regionName,
			label: requestedTurfLabel(t),
			caveats,
			ready: t.placement !== null && caveats.length === 0,
		};
	});

	const notes = [
		...(run.report?.campaigns ?? []).flatMap(campaignNotes),
		...requestedFolderNote(run.report?.campaigns ?? []),
		...drainNotes(run.report?.drain, run.report?.campaigns ?? []),
	];
	const running = !run.finishedAt && !run.stalled;
	// Only when every campaign was read: otherwise the reason is the note
	// above, not the folder.
	const campaigns = run.report?.campaigns ?? [];
	const allRead = campaigns.length > 0 && campaigns.every((c) => c.outcome === 'synced');
	if (run.finishedAt && found.total === 0 && allRead) {
		notes.push({
			text:
				'No new turf turned up in the requested-turf folder. If you just cut it, check in VAN ' +
				'that it was saved in that folder. Turf picked up before you pressed is under Requested ' +
				'turf below, newest first.',
			error: false,
		});
	}

	return {
		running,
		status: statusLine(run, now),
		stalled: run.stalled,
		notes,
		newTurf,
		newTurfTotal: found.total,
	};
}

function statusLine(run: ManualSyncRun, now: Date): string {
	const by = run.startedByName ? ` by ${run.startedByName}` : '';
	const started = `Started ${relativeSince(run.startedAt, now)}${by}.`;
	if (run.stalled) {
		return `The sync stopped partway — the server restarted. ${started} Press Sync VAN now to run it again.`;
	}
	if (run.finishedAt) return `Sync finished ${relativeSince(run.finishedAt, now)}. ${started}`;
	const again = run.passes > 1 ? ' again, for a press made meanwhile' : '';
	switch (run.phase) {
		case 'waiting':
			return `Waiting for the scheduled sync that is running to finish, then reading VAN. ${started}`;
		case 'shapes':
			return `Loading map shapes, new turf first. ${started}`;
		default:
			return `Reading turf from VAN${again}. ${started}`;
	}
}

function campaignNotes(c: CampaignPassReport): ManualSyncNote[] {
	const notes: ManualSyncNote[] = [];
	if (c.outcome === 'failed') {
		notes.push({
			text: `${c.name}: the VAN sync failed${c.error ? ` — ${c.error}` : ''}. No new turf was read.`,
			error: true,
			campaignId: c.campaignId,
		});
	} else if (c.outcome === 'skipped') {
		notes.push({
			text: `${c.name}: not read this time — another sync was using it. Its new turf comes with the next sync.`,
			error: false,
		});
	}
	if (c.foldersSkipped) {
		notes.push({
			text: `${c.name}: ran out of time before reading ${plural(c.foldersSkipped, 'folder')}; their new turf comes with the next sync.`,
			error: false,
		});
	}
	if (c.newRoutesHeld) {
		notes.push({
			text:
				`${c.name}: ${plural(c.newRoutesHeld, 'new route')} not added yet. They replace turf ` +
				`volunteers already have out today, so they wait until midnight.`,
			error: false,
		});
	}
	return notes;
}

/** Only when no campaign has one: a campaign that takes no requests is fine. */
function requestedFolderNote(campaigns: CampaignPassReport[]): ManualSyncNote[] {
	if (campaigns.length === 0 || campaigns.some((c) => !c.noRequestedFolder)) return [];
	return [
		{
			text:
				'No campaign has a requested-turf folder set, so turf cut for requests is never read. ' +
				'Set one in the campaign’s settings.',
			error: true,
			campaignId: campaigns[0]!.campaignId,
		},
	];
}

function drainNotes(
	drain: CampaignDrain[] | undefined,
	campaigns: CampaignPassReport[],
): ManualSyncNote[] {
	if (!drain) return [];
	const name = (id: number) => campaigns.find((c) => c.campaignId === id)?.name ?? `Campaign ${id}`;
	const notes: ManualSyncNote[] = [];
	for (const d of drain) {
		if (d.failed) {
			notes.push({
				text: `${name(d.campaignId)}: loading map shapes failed — ${d.failed}. The rest load with the scheduled syncs.`,
				error: true,
			});
		}
		if (d.stopped === 'not configured') {
			notes.push({
				text: `${name(d.campaignId)}: map shapes cannot load — the campaign has no export job type or no working API key.`,
				error: true,
				campaignId: d.campaignId,
			});
		}
	}
	const attempted = drain.reduce((n, d) => n + d.attempted, 0);
	const mapped = drain.reduce((n, d) => n + d.mapped, 0);
	if (attempted > 0) {
		const stopped = drain.find((d) => d.stopped && d.stopped !== 'not configured')?.stopped;
		const why =
			stopped === 'out of time'
				? ' The rest load with the scheduled syncs.'
				: stopped === 'lock busy'
					? ' Another sync was using VAN; the rest load with the scheduled syncs.'
					: stopped === 'resync requested'
						? ' Paused to read VAN again for a newer press.'
						: '';
		notes.push({
			text: `Map shapes: ${mapped} of ${plural(attempted, 'turf')} put on the map.${why}`,
			error: false,
		});
	}
	return notes;
}

function plural(n: number, noun: string): string {
	return `${n.toLocaleString('en-US')} ${noun}${n === 1 || noun.endsWith('turf') ? '' : 's'}`;
}
