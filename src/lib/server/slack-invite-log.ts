// Persistence for the hourly Slack invite audit.
//
// The audit itself is stateless — it re-reads every page and re-checks every
// link each run — because Solidarity offers no change signal to trust (no
// `updated_at` on a page, no ETag on the public site). This module is what
// gives those stateless runs a memory: when a link first appeared on a page,
// when it went bad, and when it was fixed.

import { eq, and, desc } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { slackInviteSightings, type SlackInviteSightingRow } from './schema.js';
import type { AuditResult, InviteRef, InviteStatus } from './slack-invite-audit.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

export interface SightingChange {
	ref: InviteRef;
	from: InviteStatus | null;
	to: InviteStatus;
}

/**
 * Fold this run's findings into the ledger and report what actually changed.
 *
 * Returns only genuine transitions — a link that was broken last hour and is
 * still broken now is not a change. The audit posts a full report every run, so
 * this is what lets the report lead with "newly broken since the last check"
 * rather than making a human diff two Slack messages by eye.
 */
export async function recordAudit(
	db: Db,
	result: AuditResult,
	now = new Date().toISOString(),
): Promise<SightingChange[]> {
	const changes: SightingChange[] = [];

	for (const ref of result.refs) {
		const verdict = result.statuses.get(ref.url);
		if (!verdict) continue;

		const existing: SlackInviteSightingRow[] = await db
			.select()
			.from(slackInviteSightings)
			.where(
				and(
					eq(slackInviteSightings.pageId, ref.pageId),
					eq(slackInviteSightings.location, ref.location),
					eq(slackInviteSightings.url, ref.url),
				),
			)
			.limit(1);

		const prior = existing[0];

		if (!prior) {
			await db.insert(slackInviteSightings).values({
				pageId: ref.pageId,
				pageName: ref.pageName,
				pageUrl: ref.pageUrl,
				location: ref.location,
				url: ref.url,
				status: verdict.status,
				detail: verdict.detail,
				previousStatus: null,
				firstSeenAt: now,
				lastSeenAt: now,
				statusChangedAt: now,
			});
			// A link we have never seen before is only worth announcing as a change
			// when it is already bad — a newly added working link is just an edit.
			if (verdict.status !== 'valid') {
				changes.push({ ref, from: null, to: verdict.status });
			}
			continue;
		}

		const changed = prior.status !== verdict.status;
		await db
			.update(slackInviteSightings)
			.set({
				pageName: ref.pageName,
				pageUrl: ref.pageUrl,
				status: verdict.status,
				detail: verdict.detail,
				lastSeenAt: now,
				...(changed ? { previousStatus: prior.status, statusChangedAt: now } : {}),
			})
			.where(eq(slackInviteSightings.id, prior.id));

		if (changed) {
			changes.push({ ref, from: prior.status as InviteStatus, to: verdict.status });
		}
	}

	return changes;
}

/** The current ledger, worst first, for the /settings page or a manual look. */
export async function listSightings(db: Db): Promise<SlackInviteSightingRow[]> {
	return db.select().from(slackInviteSightings).orderBy(desc(slackInviteSightings.lastSeenAt));
}

/** Slack mrkdwn for the transitions since the previous run, or '' if none. */
export function formatChanges(changes: SightingChange[]): string {
	if (changes.length === 0) return '';

	const broke = changes.filter((c) => c.to === 'broken');
	const fixed = changes.filter((c) => c.from === 'broken' && c.to === 'valid');
	const lines: string[] = [];

	if (broke.length > 0) {
		lines.push(`:new: *Newly broken since the last check:*`);
		for (const c of broke) {
			lines.push(`• ${c.ref.pageName} — ${c.ref.location}`);
		}
	}
	if (fixed.length > 0) {
		lines.push(`:tada: *Fixed since the last check:*`);
		for (const c of fixed) {
			lines.push(`• ${c.ref.pageName} — ${c.ref.location}`);
		}
	}
	return lines.join('\n');
}
