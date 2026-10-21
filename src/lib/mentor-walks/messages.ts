// Every message mentor walks sends (specs/015-mentor-walks, User Stories 5–7),
// worded as reviewed in the Story 0 prototype.
//
// Written once, as Slack mrkdwn: a Slack volunteer gets it as a DM, and a
// Google or Apple volunteer sees the same words as a notice on /turfs, which
// noticeLines ($lib/van/notice-text.ts) turns into plain text and same-site
// links. Anything a person typed (a name, a place, a note) is escaped, so it
// can't become a link or a mention.

import type { KnownBlock } from '@slack/web-api';
import { campaignTimeLabel } from '../campaign-time.js';
import { walkDateLabel, walkDayLabel } from './rules.js';

/** What a message needs to know about a walk. */
export interface WalkFacts {
	/** The walk's public id, for links to its card. */
	publicId: string;
	chapterId: number;
	mentorName: string;
	startsAt: string;
	place: string;
	note: string | null;
	/** How to spot the mentor: "Campaign merch". */
	lookFor: string;
	phone: string | null;
	seats: number;
}

/** The kinds of message, which become the push notification's title. */
export type WalkMessageKind =
	| 'walk-joined'
	| 'walk-left'
	| 'walk-changed'
	| 'walk-off'
	| 'walk-reminder'
	| 'walk-checkin'
	| 'walk-howdid'
	| 'walk-alert'
	| 'mentor-revoked';

export const WALK_MESSAGE_TITLES: Record<WalkMessageKind, string> = {
	'walk-joined': 'Someone joined your walk',
	'walk-left': 'Someone left your walk',
	'walk-changed': 'Your mentor walk changed',
	'walk-off': 'Your mentor walk was cancelled',
	'walk-reminder': 'Mentor walk today',
	'walk-checkin': 'Who showed up?',
	'walk-howdid': 'How did your walk go?',
	'walk-alert': 'A mentor walk near you',
	'mentor-revoked': 'Your mentor status ended',
};

/** Slack's three escapes, and no `*` or `_`, which would restyle the text. */
export function esc(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/[*_~`]/g, '');
}

/** "Ypsilanti District Library" from "Ypsilanti District Library, 229 W Michigan Ave". */
function shortPlace(place: string): string {
	return place.split(',')[0].trim() || place;
}

function firstName(name: string): string {
	return name.trim().split(/\s+/)[0] ?? name;
}

/** "Today at 5:30 PM", or "today at 5:30 PM" inside a sentence. */
export function whenLabel(startsAt: string, now: Date, lower = false): string {
	const day = walkDayLabel(startsAt, now);
	const label = `${day} at ${campaignTimeLabel(startsAt)}`;
	return lower && (day === 'Today' || day === 'Tomorrow' || day === 'Yesterday')
		? label[0].toLowerCase() + label.slice(1)
		: label;
}

/** The walk's card on /turfs. */
export function walkLink(appUrl: string, walk: Pick<WalkFacts, 'publicId' | 'chapterId'>): string {
	return `<${appUrl}/turfs?chapter=${walk.chapterId}#walk-${walk.publicId}|/turfs>`;
}

function seatsLeftLine(left: number, seats: number): string {
	return `${left} of ${seats} ${seats === 1 ? 'seat' : 'seats'} left.`;
}

/** To the mentor: someone took a seat (FR-023). */
export function joinedMessage(walk: WalkFacts, who: string, left: number, now: Date): string {
	return [
		endSentence(
			`*${esc(who)}* joined your walk *${whenLabel(walk.startsAt, now)}* at ${esc(shortPlace(walk.place))}`,
		),
		seatsLeftLine(left, walk.seats),
	].join('\n');
}

/** To the mentor: someone gave up their seat (FR-023). */
export function leftMessage(walk: WalkFacts, who: string, left: number, now: Date): string {
	return [
		`*${esc(who)}* can no longer make your walk *${whenLabel(walk.startsAt, now)}*.`,
		seatsLeftLine(left, walk.seats),
	].join('\n');
}

/** To each seat holder: the time or place changed (FR-024). */
export function changedMessage(walk: WalkFacts, appUrl: string, now: Date): string {
	return [
		`*${esc(walk.mentorName)}* changed the walk you're joining.`,
		endSentence(`Now: *${whenLabel(walk.startsAt, now)}* at ${esc(walk.place)}`),
		`If you can't make the new time, you can give up your seat on ${walkLink(appUrl, walk)}.`,
	].join('\n');
}

/** To each seat holder: the walk is off, whoever called it off (FR-024). */
export function offMessage(walk: WalkFacts, appUrl: string, now: Date): string {
	return [
		`The walk with *${esc(walk.mentorName)}* on *${whenLabel(walk.startsAt, now)}* has been cancelled.`,
		`Other walks near you are on <${appUrl}/turfs?chapter=${walk.chapterId}|/turfs>.`,
	].join('\n');
}

/** To each seat holder, about REMINDER_HOURS before (FR-025). */
export function reminderMessage(walk: WalkFacts, now: Date): string {
	const meet = [endSentence(`Meet at ${esc(walk.place)}`), walk.note ? esc(walk.note) : '']
		.filter(Boolean)
		.join(' ');
	return [
		`Reminder: you're walking with *${esc(walk.mentorName)}* *${whenLabel(walk.startsAt, now, true)}*.`,
		meet,
		endSentence(`Look for: ${esc(walk.lookFor)}`),
		walk.phone
			? `Running late? Text ${esc(firstName(walk.mentorName))} at ${esc(walk.phone)}.`
			: "The mentor didn't leave a number. Meet at the place above.",
	].join('\n');
}

/** To the mentor, once the walk has started (FR-030). */
export function mentorCheckinMessage(walk: WalkFacts, appUrl: string, now: Date): string {
	const day = walkDayLabel(walk.startsAt, now);
	const when = day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : `on ${day}`;
	return [
		`Thanks for taking new people out ${when}! Who showed up?`,
		`Tick them off on ${walkLink(appUrl, walk)}. It helps us know who to check in with next.`,
	].join('\n');
}

/** To each seat holder, once the walk has started (FR-030). */
export function howDidItGoMessage(walk: WalkFacts, appUrl: string): string {
	return [
		`How did your walk with *${esc(walk.mentorName)}* go?`,
		`Let us know on ${walkLink(appUrl, walk)}: *I went* · *Mentor didn't show* · *I couldn't make it*`,
	].join('\n');
}

/** The link that leads to "Stop these alerts" (FR-027). It opens a button
 *  rather than stopping them itself, so a link preview can't turn them off. */
export function stopAlertsUrl(appUrl: string): string {
	return `${appUrl}/turfs?mentorAlerts=stop`;
}

/** To someone who opted in: a walk near them (FR-028). `more` is the walks
 *  held back by the daily limit since their last alert. */
export function alertMessage(
	walk: WalkFacts,
	seatsOpen: number,
	miles: string,
	more: number,
	appUrl: string,
	now: Date,
): string {
	return [
		`*${esc(walk.mentorName)}* is planning a walk near you: *${whenLabel(walk.startsAt, now)}* at ${esc(shortPlace(walk.place))} (${miles}).`,
		`${seatsOpen} ${seatsOpen === 1 ? 'seat' : 'seats'} open. Join on ${walkLink(appUrl, walk)}.`,
		...(more > 0 ? [`And ${more} more ${more === 1 ? 'walk' : 'walks'} near you.`] : []),
		`<${stopAlertsUrl(appUrl)}|Stop these alerts>`,
	].join('\n');
}

/** The Turf sync channel post for a walk's first no-show report (FR-032). */
export function noShowPost(
	walk: WalkFacts,
	chapterName: string,
	reporter: string,
	appUrl: string,
): string {
	return [
		`:warning: *Mentor walk no-show reported* by ${esc(reporter)}`,
		`Mentor: *${esc(walk.mentorName)}* · ${esc(chapterName)}`,
		`Walk: ${walkDateLabel(walk.startsAt)} at ${campaignTimeLabel(walk.startsAt)} · ${esc(walk.place)}`,
		`Organizers can review it on <${appUrl}/turfs/organizer/mentor-walks|/turfs/organizer>.`,
	].join('\n');
}

/** A later report on the same walk, in the first post's thread. */
export function noShowReply(reporter: string): string {
	return endSentence(`Also reported by ${esc(reporter)}`);
}

/** A full stop, unless the text already ends in one, as "Dev M." does. */
export function endSentence(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** To a mentor an organizer revoked (or blocked). */
export function revokedMessage(): string {
	return [
		'An organizer has ended your mentor status, so your upcoming walks have been cancelled and the people who joined have been told.',
		'Questions? Reach out to your chapter organizer.',
	].join('\n');
}

/** The Slack action id of an alert's "Stop these alerts" button. */
export const STOP_ALERTS_ACTION_ID = 'mentor_walk_alerts_stop';

/** Under an alert DM: stops alerts in one tap (FR-027). */
export const STOP_ALERTS_BLOCKS: KnownBlock[] = [
	{
		type: 'actions',
		elements: [
			{
				type: 'button',
				action_id: STOP_ALERTS_ACTION_ID,
				text: { type: 'plain_text', text: 'Stop these alerts' },
				value: 'stop',
			},
		],
	},
];
