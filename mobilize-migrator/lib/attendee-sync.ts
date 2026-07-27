// Mirrors Mobilize signups into Solidarity as event RSVPs.
//
// Pure of $env and node:fs so the CLI and the SvelteKit endpoint share it:
// persistence arrives through `AttendeeLedger`, credentials through
// `AttendeeSyncConfig`. Same shape as sync.ts.
//
// Privacy: this handles real people's emails and phone numbers. Logs go to Fly
// and Slack, so nothing here logs contact details — only counts and Solidarity
// user ids.

import { fetchTimeslotParticipations, type MobilizeParticipation } from './attendees.js';
import { MobilizeError } from './mobilize.js';
import {
	createUser,
	findExistingUser,
	normalizeEmail,
	normalizePhone,
	resolveChapterId,
} from './people.js';
import {
	attendingFor,
	createAttendance,
	createRsvp,
	listSessionRsvps,
	updateRsvp,
} from './rsvp.js';
import type { MobilizeSession } from './session.js';

/** One Mobilize timeslot paired with the Solidarity session it mirrors. */
export interface TimeslotLink {
	mobilizeTimeslotId: number;
	solidarityEventId: number;
	solidaritySessionId: number;
	/** Chapter that owns the event, used as the fallback for new profiles. */
	eventChapterId: number | null;
	/** Absolute start, so callers can select only imminent events. */
	startsAt: number;
}

export interface RsvpRecord {
	mobilizeAttendanceId: number;
	solidarityRsvpId: number | null;
	solidarityUserId: number;
	solidaritySessionId: number;
	status: string;
	attended: boolean;
}

export interface AttendeeLedger {
	rsvpsByAttendanceId(): Promise<Map<number, RsvpRecord>>;
	recordRsvp(record: RsvpRecord): Promise<void>;
}

export interface AttendeeSyncConfig {
	session: MobilizeSession;
	solidarityToken: string;
	apply: boolean;
	/** Refuse to create more than this many new profiles in one run. */
	maxNewProfiles: number;
	pauseMs?: number;
	log?: (message: string) => void;
}

export interface AttendeeSyncReport {
	timeslots: number;
	participations: number;
	rsvpsCreated: number;
	rsvpsUpdated: number;
	attendancesRecorded: number;
	profilesCreated: number;
	matchedByEmail: number;
	matchedByPhone: number;
	unchanged: number;
	/** No email and no phone — nothing to match or create on. */
	skippedNoContact: number;
	/** Mobilize status we don't have a mapping for. */
	skippedUnknownStatus: number;
	/** Shifts whose signup list Mobilize refused to fully enumerate. */
	truncatedTimeslots: number;
	abortedReason?: string;
	sessionExpired: boolean;
	failed: number;
	errors: string[];
}

function emptyReport(): AttendeeSyncReport {
	return {
		timeslots: 0,
		participations: 0,
		rsvpsCreated: 0,
		rsvpsUpdated: 0,
		attendancesRecorded: 0,
		profilesCreated: 0,
		matchedByEmail: 0,
		matchedByPhone: 0,
		unchanged: 0,
		skippedNoContact: 0,
		skippedUnknownStatus: 0,
		truncatedTimeslots: 0,
		sessionExpired: false,
		failed: 0,
		errors: [],
	};
}

/** Stable, non-identifying handle for logs and error messages. */
function refFor(participation: MobilizeParticipation): string {
	return `participation ${participation.id}`;
}

export async function runAttendeeSync(
	links: TimeslotLink[],
	config: AttendeeSyncConfig,
	ledger: AttendeeLedger,
	zipChapters: Map<string, { chapterId: number }>,
	defaultChapterId: number | null,
): Promise<AttendeeSyncReport> {
	const log = config.log ?? (() => {});
	// Solidarity allows 60 requests / 30s. Each unmatched person costs two
	// lookups plus a write, so anything faster than ~600ms spends the run
	// sitting in 30-second rate-limit backoffs. Rows already in the ledger skip
	// the API entirely, so steady-state runs are far cheaper than the first.
	const pause = () => new Promise((r) => setTimeout(r, config.pauseMs ?? 600));
	const report = emptyReport();
	const known = await ledger.rsvpsByAttendanceId();

	// Collect first so the new-profile guardrail can be evaluated before any write.
	const pending: { link: TimeslotLink; participation: MobilizeParticipation }[] = [];
	for (const link of links) {
		try {
			const { participations, truncated } = await fetchTimeslotParticipations(
				link.mobilizeTimeslotId,
				config.session,
			);
			report.timeslots++;
			if (truncated) {
				report.truncatedTimeslots++;
				report.errors.push(
					`timeslot ${link.mobilizeTimeslotId}: Mobilize reported too many participations — the signup list is incomplete`,
				);
			}
			for (const participation of participations) {
				pending.push({ link, participation });
			}
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.sessionExpired = true;
				report.errors.push('Mobilize session expired (403) — refresh MOBILIZE_COOKIE');
				return report;
			}
			report.failed++;
			report.errors.push(
				`timeslot ${link.mobilizeTimeslotId}: ${err instanceof Error ? err.message : err}`,
			);
		}
		await pause();
	}
	report.participations = pending.length;

	// RSVPs already in Solidarity, so ones entered there directly aren't doubled.
	const existingBySession = new Map<number, Map<number, { id: number; is_attending: string }>>();
	for (const sessionId of new Set(pending.map((p) => p.link.solidaritySessionId))) {
		try {
			const rows = await listSessionRsvps(config.solidarityToken, sessionId);
			existingBySession.set(
				sessionId,
				new Map(rows.map((r) => [r.user_id, { id: r.id, is_attending: r.is_attending }])),
			);
		} catch (err) {
			report.failed++;
			report.errors.push(`rsvp list ${sessionId}: ${err instanceof Error ? err.message : err}`);
		}
	}

	let projectedNewProfiles = 0;

	for (const { link, participation } of pending) {
		const attending = attendingFor(participation.status);
		if (!attending) {
			report.skippedUnknownStatus++;
			continue;
		}

		const email = normalizeEmail(participation.email);
		const phone = normalizePhone(participation.phone);
		if (!email && !phone) {
			report.skippedNoContact++;
			continue;
		}

		const priorRecord = known.get(participation.id);
		// Already mirrored and nothing changed — the common case on re-runs.
		// Attendance is compared too: checking only `!participation.attended`
		// meant everyone who showed up was re-matched and re-checked on every
		// run for as long as the event stayed inside the lookback window.
		if (
			priorRecord &&
			priorRecord.status === participation.status &&
			priorRecord.attended === Boolean(participation.attended)
		) {
			report.unchanged++;
			continue;
		}

		try {
			let userId = priorRecord?.solidarityUserId ?? null;

			if (userId === null) {
				const match = await findExistingUser(config.solidarityToken, {
					firstName: participation.firstName,
					lastName: participation.lastName,
					email: participation.email,
					phone: participation.phone,
					zipcode: participation.zipcode,
				});
				if (match) {
					userId = match.user.id;
					if (match.method === 'email') report.matchedByEmail++;
					else report.matchedByPhone++;
				} else {
					projectedNewProfiles++;
					if (projectedNewProfiles > config.maxNewProfiles) {
						report.abortedReason =
							`would create more than ${config.maxNewProfiles} new Solidarity profiles — ` +
							'stopping. A spike usually means matching is failing, which fills the CRM with ' +
							'duplicate people. Review, then re-run with a raised limit if it is genuine.';
						log(report.abortedReason);
						return report;
					}
					report.profilesCreated++;
					if (!config.apply) {
						// Don't skip the rest: a dry run must still project the RSVP
						// this person would get, or it reports far fewer writes than
						// the real run performs — which is exactly the number a human
						// uses to decide whether to go ahead.
						report.rsvpsCreated++;
						continue;
					}
					const chapterId = resolveChapterId(
						{
							byZip: (zip) => (zip ? (zipChapters.get(zip)?.chapterId ?? null) : null),
							eventChapterId: link.eventChapterId,
							defaultChapterId,
						},
						participation.zipcode,
					);
					if (chapterId === null) {
						report.failed++;
						report.errors.push(`${refFor(participation)}: no chapter could be resolved`);
						continue;
					}
					const created = await createUser(
						config.solidarityToken,
						{
							firstName: participation.firstName,
							lastName: participation.lastName,
							email: participation.email,
							phone: participation.phone,
							zipcode: participation.zipcode,
						},
						chapterId,
					);
					userId = created.id;
					// Already counted above, where the dry-run branch also needs it.
					log(`created Solidarity user ${userId} (chapter ${chapterId})`);
				}
			}

			if (userId === null) {
				report.failed++;
				continue;
			}

			const target = {
				eventId: link.solidarityEventId,
				sessionId: link.solidaritySessionId,
				userId,
			};
			const existing =
				existingBySession.get(link.solidaritySessionId)?.get(userId) ??
				(priorRecord?.solidarityRsvpId
					? { id: priorRecord.solidarityRsvpId, is_attending: priorRecord.status }
					: null);

			if (!config.apply) {
				if (existing) report.rsvpsUpdated++;
				else report.rsvpsCreated++;
				continue;
			}

			let rsvpId = existing?.id ?? null;
			if (rsvpId === null) {
				rsvpId = await createRsvp(config.solidarityToken, target, attending);
				report.rsvpsCreated++;
			} else if (existing && existing.is_attending !== attending) {
				await updateRsvp(config.solidarityToken, rsvpId, attending);
				report.rsvpsUpdated++;
			}

			if (participation.attended && !priorRecord?.attended) {
				await createAttendance(config.solidarityToken, target);
				report.attendancesRecorded++;
			}

			await ledger.recordRsvp({
				mobilizeAttendanceId: participation.id,
				solidarityRsvpId: rsvpId,
				solidarityUserId: userId,
				solidaritySessionId: link.solidaritySessionId,
				status: participation.status,
				attended: Boolean(participation.attended),
			});
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.sessionExpired = true;
				report.errors.push('Mobilize session expired (403) — refresh MOBILIZE_COOKIE');
				return report;
			}
			report.failed++;
			report.errors.push(`${refFor(participation)}: ${err instanceof Error ? err.message : err}`);
		}
		await pause();
	}

	return report;
}
