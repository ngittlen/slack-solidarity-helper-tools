// Who may use turf checkout at all. One pure function, called by every page
// load and every API handler that touches turf.
//
// It exists as its own module — rather than an `if` inlined into each route —
// for two reasons. First, a gate that is re-derived per route eventually gets
// derived differently in one of them, and the one that drifts is the leak.
// Second, the open/closed decision is expected to change: today anyone signed
// in may browse and claim except blocked users; if the campaign later wants a
// vetted allow-list, this is the single function that inverts, with no route
// touched.
//
// The gate covers READS, not just writes. Blocking only the claim button would
// leave the map — where the campaign is knocking, and how hard — visible to
// exactly the person who was just removed.

export interface Viewer {
	slackUserId: string;
	isAdmin: boolean;
}

export type AccessDecision =
	{ allowed: true } | { allowed: false; reason: 'blocked'; message: string };

/** Shown to a blocked user instead of the map.
 *
 *  Deliberately plain: not an error, not a 404, and not an accusation. A
 *  confusing dead end generates a support thread; a clear sentence with a
 *  next step doesn't. */
export const BLOCKED_MESSAGE =
	"Turf checkout isn't available for your account. Contact an organizer if you think that's wrong.";

/**
 * Whether `viewer` may use turf checkout.
 *
 * Admins and the superuser are never blocked, so an accidental or malicious
 * block can't lock the campaign out of its own tool. That check comes first
 * and cannot be overridden by the list.
 */
export function turfAccess(
	viewer: Viewer,
	blockedSlackUserIds: ReadonlySet<string>,
	superuserSlackUserId?: string,
): AccessDecision {
	if (viewer.isAdmin) return { allowed: true };
	if (superuserSlackUserId && viewer.slackUserId === superuserSlackUserId) {
		return { allowed: true };
	}
	if (blockedSlackUserIds.has(viewer.slackUserId)) {
		return { allowed: false, reason: 'blocked', message: BLOCKED_MESSAGE };
	}
	return { allowed: true };
}

export type BlockRefusalReason = 'is-admin' | 'is-superuser' | 'is-self';

export type BlockDecision =
	{ ok: true } | { ok: false; reason: BlockRefusalReason; message: string };

export interface BlockContext {
	/** Slack ids that currently resolve as admins. */
	adminSlackUserIds: ReadonlySet<string>;
	superuserSlackUserId?: string;
}

/**
 * Whether `actor` may block `targetSlackUserId`.
 *
 * Refusals are explicit rather than silent: an admin who tries to block another
 * admin should be told why, not watch the row fail to appear. Blocking yourself
 * is refused for the same reason it's refused elsewhere in the codebase — it's
 * almost always a misclick, and the recovery needs another admin.
 */
export function canBlock(
	actorSlackUserId: string,
	targetSlackUserId: string,
	context: BlockContext,
): BlockDecision {
	if (actorSlackUserId === targetSlackUserId) {
		return { ok: false, reason: 'is-self', message: 'You cannot block yourself.' };
	}
	if (context.superuserSlackUserId && targetSlackUserId === context.superuserSlackUserId) {
		return { ok: false, reason: 'is-superuser', message: 'The superuser cannot be blocked.' };
	}
	if (context.adminSlackUserIds.has(targetSlackUserId)) {
		return {
			ok: false,
			reason: 'is-admin',
			message: 'Admins cannot be blocked. Remove their admin access first.',
		};
	}
	return { ok: true };
}
