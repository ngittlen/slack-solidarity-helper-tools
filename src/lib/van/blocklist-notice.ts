// What gets said when someone is blocked from turf checkout, and to whom.
//
// Two audiences, two messages, and they are deliberately different:
//
//   - The admin channel gets a log line. Blocking is a moderation action taken
//     against a member, and without a trace of it two organizers can undo each
//     other — one blocks someone on Friday, another unblocks them on Saturday
//     wondering why they were on the list at all.
//   - The volunteer gets a DM, but only if the block took turf off them. This
//     is the one that prevents a real failure: someone walking to a block they
//     no longer hold, knocking doors that are now on somebody else's list.
//
// Pure — no Slack client, no DB — in the style of member-note-log.ts, so the
// wording is testable without sending anything.

/** Slack renders `<@U123>` as a live mention. Better than a stored display
 *  name in a log line: it stays right when someone changes their name, and it
 *  is unambiguous when two people share one. */
function mention(slackUserId: string): string {
	return `<@${slackUserId}>`;
}

export interface BlockNoticeInput {
	targetSlackUserId: string;
	actorSlackUserId: string;
	/** Free text the admin typed. Optional — a block does not require a stated
	 *  reason, though the editor encourages one. */
	reason?: string;
	/** Turf freed by the block. */
	releasedTurfNames: string[];
	sessionsRevoked: number;
}

/**
 * The admin-channel line for a block.
 *
 * Leads with who did what to whom, because that is what someone scanning the
 * channel later needs. The side effects follow, and they are the part an
 * organizer would otherwise have to discover: a block silently freed turf that
 * is now claimable by anyone.
 */
export function renderBlockNotice(input: BlockNoticeInput): string {
	const { targetSlackUserId, actorSlackUserId, reason, releasedTurfNames, sessionsRevoked } = input;

	const parts = [
		`:no_entry_sign: ${mention(targetSlackUserId)} was blocked from turf checkout by ${mention(actorSlackUserId)}.`,
	];

	const trimmed = (reason ?? '').trim();
	if (trimmed) parts.push(`Reason: ${trimmed}`);

	if (releasedTurfNames.length > 0) {
		const list = releasedTurfNames.join(', ');
		parts.push(
			`Freed ${releasedTurfNames.length} turf${releasedTurfNames.length === 1 ? '' : 's'} they were holding — ${list} — now claimable by anyone. They have been DMed.`,
		);
	}

	if (sessionsRevoked > 0) {
		parts.push(
			`Signed them out of ${sessionsRevoked} session${sessionsRevoked === 1 ? '' : 's'}, so the block applies on their next request.`,
		);
	}

	return parts.join('\n');
}

/** The admin-channel line for an unblock. Deliberately notes what unblocking
 *  does NOT do — turf released by the block is not handed back, and an
 *  organizer who assumes otherwise will wonder where it went. */
export function renderUnblockNotice(targetSlackUserId: string, actorSlackUserId: string): string {
	return (
		`:white_check_mark: ${mention(targetSlackUserId)} was unblocked from turf checkout by ${mention(actorSlackUserId)}. ` +
		'They can claim turf again. Anything freed when they were blocked is not returned — they claim it like anyone else.'
	);
}

/**
 * The DM to someone whose turf was taken by a block.
 *
 * Says what happened without saying why. The reason an admin typed is for the
 * admin channel: it is a note about a person, written for other organizers, and
 * relaying it here would turn a routine "your turf was released" into an
 * argument the DM cannot hold. Whoever blocked them can explain; the DM's job
 * is to stop them walking to a turf that is no longer theirs.
 *
 * Returns null when nothing was released — there is no failure to prevent, and
 * a message telling someone they have been blocked, unprompted and with no
 * recourse in it, is worse than the silence.
 */
export function renderBlockedHolderDm(turfNames: string[]): string | null {
	if (turfNames.length === 0) return null;

	const many = turfNames.length > 1;
	return [
		`:warning: *${many ? 'Your turfs have' : 'Your turf has'} been released.*`,
		'',
		turfNames.map((name) => `• ${name}`).join('\n'),
		'',
		`${many ? 'They are' : 'It is'} back in the pool and someone else may already have ${many ? 'them' : 'it'}, so please don't head out to ${many ? 'them' : 'it'}.`,
		'Turf checkout is not available for your account at the moment — an organizer can tell you more.',
	].join('\n');
}
