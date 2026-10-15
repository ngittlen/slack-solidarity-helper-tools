// The two holder notices that arrived with push notifications: a claim that
// lapsed, and VAN having started to count a walk's doors. Slack mrkdwn, like every
// other holder notice, so the page (notice-text.ts) and the push
// (noticePushText) read them the same way. Neither is ever a Slack DM — see
// PUSH_ONLY in holder-notices.ts.

export interface LapsedNoticeInput {
	turfName: string;
	chapterId: number;
	appUrl: string;
}

/** Written as a fact, not a telling-off, for the same reason as the expiry
 *  warning: most lapsed turf is a weekend that ran out. */
export function renderLapsedNotice({ turfName, chapterId, appUrl }: LapsedNoticeInput): string {
	return [
		`:hourglass: *Your hold on ${turfName} has ended.*`,
		'',
		'It went back to the pool so someone else can walk it. If you still want it, it may be ' +
			'free to take again.',
		`<${appUrl}/turfs?chapter=${chapterId}|Open turf checkout>`,
	].join('\n');
}

export interface DoorsCountedNoticeInput {
	turfName: string;
	doors: number;
	appUrl: string;
}

/** Sent the first time VAN shows any of the walk's doors, while later ones
 *  may still be syncing, so `doors` is the count so far, never "the total". */
export function renderDoorsCountedNotice({
	turfName,
	doors,
	appUrl,
}: DoorsCountedNoticeInput): string {
	const counted = doors === 1 ? '1 door' : `${doors.toLocaleString('en-US')} doors`;
	return [
		`:white_check_mark: *VAN has your doors from ${turfName}.*`,
		'',
		`It had ${counted} when we checked. Any still syncing from MiniVAN are added as they ` +
			'arrive. Thanks for walking it.',
		`<${appUrl}/turfs|Find more turf>`,
	].join('\n');
}
