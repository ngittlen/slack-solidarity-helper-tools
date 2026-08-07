// The one-line summary posted to the admin tracking channel whenever a member
// note or warning is logged.
//
// Pure so the wording — especially the conditional "and warning … sent to
// them" clause — is unit-testable without Slack.

export interface NoteLogInput {
	kind: 'note' | 'warning';
	/** What the admin typed in Details. */
	body: string;
	targetSlackUserId: string;
	authorSlackUserId: string;
	/** The DM text actually delivered, or null when none was sent — because it
	 *  was a note, the admin unchecked Notify, or the send failed. Drives the
	 *  optional clause; a warning that never reached the member must not claim
	 *  it did. */
	dmBody: string | null;
}

/** Collapse newlines and runs of whitespace so a multi-line note still reads as
 *  one sentence in the channel. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * `Note "…" added to user <@U1> by <@U2>`
 * `Warning "…" added to user <@U1> and warning "…" sent to them by <@U2>`
 */
export function renderMemberNoteLog(input: NoteLogInput): string {
	const label = input.kind === 'warning' ? 'Warning' : 'Note';
	const body = oneLine(input.body);
	const sent = input.dmBody ? ` and warning “${oneLine(input.dmBody)}” sent to them` : '';
	return `${label} “${body}” added to user <@${input.targetSlackUserId}>${sent} by <@${input.authorSlackUserId}>`;
}
