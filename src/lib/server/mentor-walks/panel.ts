// The mentor area of /turfs (specs/015-mentor-walks, User Stories 1 and 2):
// what it shows, and the form actions behind it.
//
// Kept out of the route so the page's load and actions stay readable, and so
// these can be tested against a real database without SvelteKit. Every
// action recomputes the panel state from the database rather than trusting
// the page: an action is only allowed when the screen it belongs to would be
// showing now.

import type { drizzle } from 'drizzle-orm/libsql';
import type { SessionData } from '../db.js';
import type { Settings } from '../settings.js';
import { lookupAddress } from '../van/zip-centroid.js';
import {
	agreeToGuidelines,
	answerInvite,
	cancelWalk,
	createWalk,
	eligibilityCounts,
	hasCheckedOutTurf,
	latestLookFor,
	loadWalkByPublicId,
	latestPhone,
	listMentorWalks,
	loadMentor,
	loadWalk,
	mentorStats,
	mentorWalkSlots,
	updateWalk,
	type WalkFields,
} from './store.js';
import {
	DEFAULT_LOOK_FOR,
	featureVisible,
	finderState,
	isAlertRadius,
	isEligible,
	isNew,
	mentorPanelState,
	needsEligibility,
	normalizePhone,
	oneLine,
	PLACE_MAX_LENGTH,
	validateWalk,
	walkDayLabel,
	walkInputsFromStart,
	walkStarted,
	walkStartFromInputs,
	type MentorPanelState,
} from '../../mentor-walks/rules.js';
import type {
	AlertsView,
	ChapterOption,
	MentorDebugView,
	MentorPanelView,
	PlaceLocation,
	WalkCardView,
	WalkFinderView,
} from '../../mentor-walks/types.js';
import { campaignDayLabel, campaignTimeLabel } from '../../campaign-time.js';
import { dispatchSoon } from './dispatch.js';
import {
	answerWalk,
	attendedCount,
	cardWalks,
	heldSeats,
	holderSeats,
	joinWalk,
	leaveWalk,
	loadPrompt,
	saveAttendance,
	setPrompt,
	walksAwaitingCheckin,
	type JoinRefusal,
	type WalkAnswer,
} from './seats.js';
import { queueJoined, queueLeft } from './walk-events.js';
import { postNoShows, type NoShowDeps } from './no-show.js';
import type { MentorWalkRow, MentorWalkSeatRow } from '../schema.js';
import { loadAlerts, saveAlerts, stopAlerts } from './alerts.js';
import { errMessage } from '../../err-message.js';

export type { MentorDebugView };

type Db = ReturnType<typeof drizzle>;

type Viewer = Pick<
	SessionData,
	'slackUserId' | 'slackUserName' | 'isAdmin' | 'isModerator' | 'mentorSimulation'
>;

export interface PanelContext {
	viewer: Viewer;
	settings: Pick<Settings, 'mentorWalksVisibility' | 'volunteerGuidelinesUrl'>;
	blocked: boolean;
	now: Date;
}

/** An admin trying the feature out on themselves from the debug panel:
 *  eligible, and shown the feature whatever the setting. */
function simulating(viewer: Viewer): boolean {
	return viewer.isAdmin && viewer.mentorSimulation === true;
}

function visible(ctx: PanelContext): boolean {
	if (simulating(ctx.viewer)) return !ctx.blocked;
	return featureVisible(ctx.settings.mentorWalksVisibility, ctx.viewer, ctx.blocked);
}

/** Which mentor screen the viewer gets now, or null for none. */
async function panelState(db: Db, ctx: PanelContext): Promise<MentorPanelState | null> {
	if (!visible(ctx)) return null;
	const row = await loadMentor(db, ctx.viewer.slackUserId);
	const eligible = needsEligibility(row, ctx.now)
		? simulating(ctx.viewer) || isEligible(await eligibilityCounts(db, ctx.viewer.slackUserId))
		: false;
	return mentorPanelState(row, eligible, ctx.settings.volunteerGuidelinesUrl, ctx.now);
}

/**
 * The mentor area for /turfs. Never throws: a failed read costs the panel for
 * this visit, not the turf map.
 */
export async function loadMentorPanel(
	db: Db,
	ctx: PanelContext & {
		/** Chapters a new walk can be posted in. */
		chapters: ChapterOption[];
		/** Every chapter's name, hidden ones too, for walks posted before
		 *  their chapter was hidden. */
		chapterNames: ReadonlyMap<number, string>;
	},
): Promise<MentorPanelView | null> {
	try {
		const state = await panelState(db, ctx);
		const guidelinesUrl = ctx.settings.volunteerGuidelinesUrl;
		if (state === null) return null;
		if (state === 'invite' || state === 'declined') return { state, guidelinesUrl };

		const id = ctx.viewer.slackUserId;
		const [walks, stats, defaultPhone, defaultLookFor, awaiting] = await Promise.all([
			listMentorWalks(db, id, ctx.now),
			mentorStats(db, id, ctx.now),
			latestPhone(db, id),
			latestLookFor(db, id),
			walksAwaitingCheckin(db, id, ctx.now),
		]);
		const seats = await heldSeats(
			db,
			[...walks, ...awaiting].map((w) => w.id),
		);
		return {
			state,
			guidelinesUrl,
			walks: walks.map((w) => ({
				id: w.publicId,
				dayLabel: campaignDayLabel(w.startsAt),
				timeLabel: campaignTimeLabel(w.startsAt),
				place: w.place,
				seats: w.seats,
				joined: (seats.get(w.id) ?? []).map((s) => s.holderName),
				chapterName: ctx.chapterNames.get(w.chapterId) ?? `Chapter ${w.chapterId}`,
				draft: {
					chapterId: w.chapterId,
					...walkInputsFromStart(w.startsAt),
					place: w.place,
					point: { lat: w.lat, lng: w.lng },
					note: w.note ?? '',
					lookFor: w.lookFor ?? DEFAULT_LOOK_FOR,
					seats: w.seats,
					phone: w.phone ?? '',
				},
			})),
			...stats,
			defaultPhone,
			defaultLookFor,
			chapters: ctx.chapters,
			checkins: awaiting.map((w) => ({
				walkId: w.publicId,
				dayLabel: walkDayLabel(w.startsAt, ctx.now),
				timeLabel: campaignTimeLabel(w.startsAt),
				place: w.place,
				seats: (seats.get(w.id) ?? []).map((s) => ({
					id: String(s.id),
					name: s.holderName,
					ticked: s.mentorTicked,
				})),
			})),
		};
	} catch (err) {
		console.error('[mentor-walks] could not load the mentor panel:', errMessage(err));
		return null;
	}
}

export type ActionResult<T> =
	{ ok: true; value: T } | { ok: false; status: number; message: string };

const NOT_AVAILABLE = 'That isn’t available any more. Refresh the page.';

function refuse(status: number, message: string): ActionResult<never> {
	return { ok: false, status, message };
}

function person(viewer: Viewer) {
	return { id: viewer.slackUserId, name: viewer.slackUserName };
}

/** "Not now" or "No thanks" on the invitation (FR-004). */
export async function answerInvitation(
	db: Db,
	ctx: PanelContext,
	answer: string,
): Promise<ActionResult<'snooze' | 'decline'>> {
	if (answer !== 'snooze' && answer !== 'decline') return refuse(400, 'Unknown answer.');
	if ((await panelState(db, ctx)) !== 'invite') return refuse(409, NOT_AVAILABLE);
	await answerInvite(db, person(ctx.viewer), answer, ctx.now);
	return { ok: true, value: answer };
}

/** Longer than any link the settings page accepts. */
const GUIDELINES_URL_MAX_LENGTH = 2048;

export const GUIDELINES_CHANGED =
	'The volunteer guidelines link changed while you were reading. Have a look at the new one.';

/**
 * Agree to the guidelines (FR-005): from the invitation, from the "Become a
 * mentor" link after declining, or when asked to agree again.
 *
 * `shownUrl` is the link the page showed them, and it's what is recorded:
 * they agreed to what they saw. If the setting has changed since, they're a
 * mentor who must agree again, and are told why.
 */
export async function agree(
	db: Db,
	ctx: PanelContext,
	ticked: boolean,
	shownUrl: string,
): Promise<ActionResult<true>> {
	if (!ticked) return refuse(400, 'Tick the box to agree to the volunteer guidelines.');
	const shown = shownUrl.trim();
	if (shown === '' || shown.length > GUIDELINES_URL_MAX_LENGTH) return refuse(400, NOT_AVAILABLE);
	const state = await panelState(db, ctx);
	if (state !== 'invite' && state !== 'agree' && state !== 'declined') {
		return refuse(409, NOT_AVAILABLE);
	}
	if (!(await agreeToGuidelines(db, person(ctx.viewer), shown, ctx.now))) {
		return refuse(409, NOT_AVAILABLE);
	}
	if (shown !== ctx.settings.volunteerGuidelinesUrl) return refuse(409, GUIDELINES_CHANGED);
	return { ok: true, value: true };
}

export interface WalkForm {
	walkId: string | null;
	chapterId: string;
	date: string;
	time: string;
	place: string;
	/** Where the place was found, as the mentor saw it on the map. */
	lat: string;
	lng: string;
	note: string;
	lookFor: string;
	seats: string;
	phone: string;
}

export const PLACE_NOT_FOUND =
	"We couldn't find that address. Try a street address or nearby cross streets, with the town.";
export const GEOCODER_UNAVAILABLE =
	"The map lookup isn't working right now, so the place can't be checked. Try again in a few minutes.";
export const PLACE_NOT_LOCATED = 'Find the meeting place on the map first.';

/**
 * Find a meeting place on the map (FR-007), for the mentor to check before
 * posting: the geocoder sometimes takes a half-understood address to the
 * wrong town, so it shows them the pin and the address it matched.
 */
export async function locatePlace(
	db: Db,
	ctx: PanelContext,
	place: string,
	lookup: typeof lookupAddress = lookupAddress,
): Promise<ActionResult<PlaceLocation>> {
	if ((await panelState(db, ctx)) !== 'mentor') return refuse(409, NOT_AVAILABLE);
	const query = place.trim();
	if (query === '') return refuse(400, 'Add a meeting place.');
	if (query.length > PLACE_MAX_LENGTH) {
		return refuse(400, `Keep the meeting place under ${PLACE_MAX_LENGTH} characters.`);
	}
	const found = await lookup(query);
	if (found.kind === 'unavailable') return refuse(503, GEOCODER_UNAVAILABLE);
	if (found.kind === 'not-found') return refuse(400, PLACE_NOT_FOUND);
	return { ok: true, value: { point: found.point, matchedAddress: found.matchedAddress } };
}

/** A point the form sent back, or null when missing or not on the globe. */
function parsePoint(lat: string, lng: string): { lat: number; lng: number } | null {
	if (lat.trim() === '' || lng.trim() === '') return null;
	const point = { lat: Number(lat), lng: Number(lng) };
	if (!Number.isFinite(point.lat) || Math.abs(point.lat) > 90) return null;
	if (!Number.isFinite(point.lng) || Math.abs(point.lng) > 180) return null;
	return point;
}

/**
 * Post a new walk, or change one (US2). Answers with every problem at once,
 * so the form can list them.
 *
 * The point comes from the form: the one locatePlace found and the mentor
 * checked on the map. It isn't looked up again, so a geocoder outage can't
 * stop a mentor changing the time or the note of a walk.
 */
export async function saveWalk(
	db: Db,
	ctx: PanelContext & { chapterIds: number[] },
	form: WalkForm,
): Promise<ActionResult<string> | { ok: false; status: 400; problems: string[] }> {
	if ((await panelState(db, ctx)) !== 'mentor') return refuse(409, NOT_AVAILABLE);
	const mentorId = ctx.viewer.slackUserId;

	const existing = form.walkId ? await loadWalkByPublicId(db, form.walkId) : null;
	if (form.walkId && (!existing || existing.mentorId !== mentorId)) {
		return refuse(404, 'That walk no longer exists.');
	}
	const walkId = existing?.id ?? null;
	let chapterIds = ctx.chapterIds;
	if (existing) {
		// A walk keeps its chapter even if /turfs has stopped offering it since.
		chapterIds = [...chapterIds, existing.chapterId];
	}

	const input = {
		chapterId: Number(form.chapterId),
		startsAt: walkStartFromInputs(form.date, form.time),
		place: oneLine(form.place),
		note: oneLine(form.note),
		lookFor: oneLine(form.lookFor),
		seats: Number(form.seats),
		phone: form.phone,
	};
	const problems = validateWalk(input, {
		now: ctx.now,
		seatsTaken: walkId === null ? 0 : ((await heldSeats(db, [walkId])).get(walkId)?.length ?? 0),
		otherWalks: await mentorWalkSlots(db, mentorId, walkId),
		chapterIds,
	});
	const point = parsePoint(form.lat, form.lng);
	if (input.place !== '' && point === null) problems.push(PLACE_NOT_LOCATED);
	if (problems.length > 0 || point === null) return { ok: false, status: 400, problems };

	const fields: WalkFields = {
		chapterId: input.chapterId,
		startsAt: input.startsAt as string,
		place: input.place,
		lat: point.lat,
		lng: point.lng,
		note: input.note,
		lookFor: input.lookFor,
		seats: input.seats,
		phone: normalizePhone(input.phone) ?? '',
	};
	const result =
		walkId === null
			? await createWalk(db, person(ctx.viewer), fields, ctx.now)
			: await updateWalk(db, mentorId, walkId, fields, ctx.now);
	if (!result.ok) return { ok: false, status: 400, problems: [result.message] };
	if (result.changed) dispatchSoon(db);
	return { ok: true, value: result.publicId };
}

/** The mentor calls a walk off (FR-010). Allowed for any active mentor, even
 *  one who has to agree to new guidelines before hosting again. */
export async function cancelOwnWalk(
	db: Db,
	ctx: PanelContext,
	rawId: string,
): Promise<ActionResult<string>> {
	if (!visible(ctx)) {
		return refuse(409, NOT_AVAILABLE);
	}
	const row = await loadMentor(db, ctx.viewer.slackUserId);
	if (row?.status !== 'active') return refuse(409, NOT_AVAILABLE);
	const walk = await loadWalkByPublicId(db, rawId);
	if (!walk || !(await cancelWalk(db, person(ctx.viewer), walk.id, ctx.now))) {
		return refuse(409, 'That walk has already started or was cancelled.');
	}
	dispatchSoon(db);
	return { ok: true, value: rawId };
}

/** Null for anyone but an admin. Never throws. */
export async function loadMentorDebug(
	db: Db,
	ctx: Omit<PanelContext, 'now'>,
): Promise<MentorDebugView | null> {
	if (!ctx.viewer.isAdmin) return null;
	try {
		const [row, counts] = await Promise.all([
			loadMentor(db, ctx.viewer.slackUserId),
			eligibilityCounts(db, ctx.viewer.slackUserId),
		]);
		return {
			simulating: simulating(ctx.viewer),
			status: row?.status ?? 'not invited',
			visibility: ctx.settings.mentorWalksVisibility,
			guidelinesSet: ctx.settings.volunteerGuidelinesUrl !== '',
			...counts,
		};
	} catch (err) {
		console.error('[mentor-walks] could not load the debug panel:', errMessage(err));
		return null;
	}
}

// ---------------------------------------------------------------------------
// Walk cards, seats and alerts (User Stories 3, 6 and 7)
// ---------------------------------------------------------------------------

/** What a blocked person, or anyone the feature is hidden from, is told about
 *  any walk: the same as for one that doesn't exist (FR-039). */
export const WALK_GONE = 'That walk isn’t available any more.';

/** How long "How did your walk go?" stays on /turfs once answered. */
const ANSWER_SHOWN_MS = 60 * 60_000;

const JOIN_REFUSALS: Record<JoinRefusal, string> = {
	gone: WALK_GONE,
	started: 'That walk has already started.',
	own: 'You can’t join your own walk.',
	full: 'Sorry, that walk is full.',
	overlap: 'You already have a seat on a walk at that time.',
	already: 'You’re already going.',
	'too-often': 'You’ve joined and left this walk too many times to join it again.',
};

function cardOf(
	walk: MentorWalkRow,
	seats: readonly MentorWalkSeatRow[],
	viewerId: string,
	now: Date,
): WalkCardView {
	const joined = seats.some((s) => s.holderId === viewerId);
	return {
		id: walk.publicId,
		chapterId: walk.chapterId,
		mentorName: walk.mentorName,
		dayLabel: walkDayLabel(walk.startsAt, now),
		timeLabel: campaignTimeLabel(walk.startsAt),
		startsAt: walk.startsAt,
		place: walk.place,
		note: walk.note ?? '',
		lookFor: walk.lookFor ?? DEFAULT_LOOK_FOR,
		seats: walk.seats,
		seatsLeft: Math.max(0, walk.seats - seats.length),
		point: { lat: walk.lat, lng: walk.lng },
		joined,
		own: walk.mentorId === viewerId,
		started: walkStarted(walk.startsAt, now),
		// FR-011: only someone holding a seat ever gets the number.
		phone: joined ? walk.phone : null,
	};
}

/** Whether the viewer counts as new (FR-013), and their prompt state. */
async function newcomer(db: Db, ctx: PanelContext) {
	const id = ctx.viewer.slackUserId;
	const [row, prompt, counts, attended] = await Promise.all([
		loadMentor(db, id),
		loadPrompt(db, id),
		eligibilityCounts(db, id),
		attendedCount(db, id),
	]);
	const newPerson = isNew({ ...counts, attended, isMentor: row?.status === 'active' });
	return { newPerson, state: finderState(prompt, newPerson, ctx.now) };
}

/**
 * The cards for the chapter on screen, the viewer's own seats, the
 * questions after a walk, and their alerts. Null when the feature is hidden
 * from them. Never throws.
 */
export async function loadWalkFinder(
	db: Db,
	ctx: PanelContext & {
		chapterId: number | null;
		/** The walk a message linked to (`?walk=12`), always among the cards. */
		linkedWalkId?: string | null;
	},
): Promise<WalkFinderView | null> {
	if (!visible(ctx)) return null;
	try {
		const id = ctx.viewer.slackUserId;
		const chapterId = ctx.chapterId;
		const heldWalks = holderSeats(db, id, ctx.now);
		const [{ state }, alerts, held, chapterWalks, checkedOut] = await Promise.all([
			newcomer(db, ctx),
			loadAlerts(db, id),
			heldWalks,
			chapterId === null
				? Promise.resolve([])
				: heldWalks.then((seats) =>
						cardWalks(db, chapterId, ctx.now, {
							linkedId: ctx.linkedWalkId ?? null,
							viewerId: id,
							heldIds: new Set(seats.map((s) => s.walk.id)),
						}),
					),
			hasCheckedOutTurf(db, id),
		]);
		const upcoming = held.filter((h) => !walkStarted(h.walk.startsAt, ctx.now));
		const seats = await heldSeats(db, [
			...new Set([...chapterWalks, ...upcoming.map((h) => h.walk)].map((w) => w.id)),
		]);
		const card = (w: MentorWalkRow) => cardOf(w, seats.get(w.id) ?? [], id, ctx.now);
		return {
			state,
			cards: chapterWalks.map(card),
			mine: upcoming.map((h) => card(h.walk)),
			checkins: held
				.filter(
					(h) =>
						walkStarted(h.walk.startsAt, ctx.now) &&
						// Answered ones stay a while, with the thanks and a way to
						// change it, so a refresh doesn't snatch them away.
						(h.seat.answer === null ||
							(h.seat.answeredAt !== null &&
								ctx.now.getTime() - new Date(h.seat.answeredAt).getTime() < ANSWER_SHOWN_MS)),
				)
				.map((h) => ({
					walkId: h.walk.publicId,
					mentorName: h.walk.mentorName,
					dayLabel: walkDayLabel(h.walk.startsAt, ctx.now),
					timeLabel: campaignTimeLabel(h.walk.startsAt),
					place: h.walk.place,
					answer: h.seat.answer,
				})),
			alerts:
				alerts && isAlertRadius(alerts.radiusMiles)
					? { zip: alerts.zip, radius: alerts.radiusMiles }
					: null,
			cardsStartOpen: !checkedOut,
		};
	} catch (err) {
		console.error('[mentor-walks] could not load the walk cards:', errMessage(err));
		return null;
	}
}

/** "Yes, show me", "Not now" or "No thanks" on the new-person prompt, or
 *  undoing No thanks (FR-014). */
export async function answerFinderPrompt(
	db: Db,
	ctx: PanelContext,
	answer: string,
): Promise<ActionResult<string>> {
	const status = (
		{ yes: 'accepted', snooze: 'snoozed', decline: 'declined', reopen: 'accepted' } as const
	)[answer as 'yes'];
	if (!status) return refuse(400, 'Unknown answer.');
	if (!visible(ctx)) return refuse(409, NOT_AVAILABLE);
	const { state } = await newcomer(db, ctx);
	const allowed = answer === 'reopen' ? state === 'declined' : state === 'prompt';
	if (!allowed) return refuse(409, NOT_AVAILABLE);
	await setPrompt(db, ctx.viewer.slackUserId, status, ctx.now);
	return { ok: true, value: answer };
}

/** The database id of the walk a public id names, for someone allowed to
 *  see walks; null otherwise, which every caller answers as WALK_GONE. */
async function walkIdFor(db: Db, ctx: PanelContext, publicId: string): Promise<number | null> {
	if (!visible(ctx)) return null;
	return (await loadWalkByPublicId(db, publicId))?.id ?? null;
}

/** Take a seat (FR-018–FR-021), and tell the mentor (FR-023). */
export async function joinWalkAction(
	db: Db,
	ctx: PanelContext,
	rawId: string,
): Promise<ActionResult<string>> {
	const id = await walkIdFor(db, ctx, rawId);
	if (id === null) return refuse(404, WALK_GONE);
	const { newPerson } = await newcomer(db, ctx);
	const result = await joinWalk(db, person(ctx.viewer), id, newPerson, ctx.now);
	if (!result.ok) return refuse(result.reason === 'gone' ? 404 : 409, JOIN_REFUSALS[result.reason]);
	const walk = await loadWalk(db, id);
	if (walk) {
		await queueJoined(
			db,
			walk,
			{ id: result.seatId, holderName: ctx.viewer.slackUserName, joinedAt: ctx.now.toISOString() },
			ctx.now,
		);
		dispatchSoon(db);
	}
	return { ok: true, value: rawId };
}

/** Give a seat up before the walk (FR-020), and tell the mentor. */
export async function leaveWalkAction(
	db: Db,
	ctx: PanelContext,
	rawId: string,
): Promise<ActionResult<string>> {
	const id = await walkIdFor(db, ctx, rawId);
	if (id === null) return refuse(404, WALK_GONE);
	const seat = await leaveWalk(db, ctx.viewer.slackUserId, id, ctx.now);
	if (!seat) return refuse(409, 'That walk has already started, or you don’t have a seat on it.');
	const walk = await loadWalk(db, id);
	if (walk) {
		await queueLeft(db, walk, seat, ctx.now);
		dispatchSoon(db);
	}
	return { ok: true, value: rawId };
}

/** I went, Mentor didn't show, or I couldn't make it (FR-030–FR-032). */
export async function answerWalkAction(
	db: Db,
	ctx: PanelContext,
	rawId: string,
	rawAnswer: string,
	noShow: NoShowDeps,
): Promise<ActionResult<WalkAnswer>> {
	const answer = (['went', 'no-show', 'missed'] as const).find((a) => a === rawAnswer);
	if (!answer) return refuse(400, 'Unknown answer.');
	const id = await walkIdFor(db, ctx, rawId);
	if (id === null) return refuse(404, WALK_GONE);
	const result = await answerWalk(db, ctx.viewer.slackUserId, id, answer, ctx.now);
	if (!result) return refuse(409, NOT_AVAILABLE);
	if (answer === 'no-show' && result.previous !== 'no-show') void postNoShows(db, id, noShow);
	return { ok: true, value: answer };
}

/** The mentor's "Who showed up?" (FR-030, FR-031). */
export async function saveAttendanceAction(
	db: Db,
	ctx: PanelContext,
	rawId: string,
	rawSeatIds: string[],
): Promise<ActionResult<string>> {
	const id = await walkIdFor(db, ctx, rawId);
	if (id === null) return refuse(404, WALK_GONE);
	const row = await loadMentor(db, ctx.viewer.slackUserId);
	if (row?.status !== 'active') return refuse(409, NOT_AVAILABLE);
	const seatIds = rawSeatIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
	if (!(await saveAttendance(db, ctx.viewer.slackUserId, id, seatIds, ctx.now))) {
		return refuse(409, NOT_AVAILABLE);
	}
	return { ok: true, value: rawId };
}

/** The viewer's nearby-walk alerts, for the header's bell (FR-027): null
 *  when the feature is hidden from them, so the bell leaves them out. */
export async function loadAlertsView(
	db: Db,
	ctx: PanelContext,
): Promise<{ alerts: AlertsView | null } | null> {
	if (!visible(ctx)) return null;
	const row = await loadAlerts(db, ctx.viewer.slackUserId);
	return {
		alerts:
			row && isAlertRadius(row.radiusMiles) ? { zip: row.zip, radius: row.radiusMiles } : null,
	};
}

/** Turn nearby-walk alerts on or change them (FR-027). */
export async function saveAlertsAction(
	db: Db,
	ctx: PanelContext,
	zip: string,
	rawRadius: string,
	lookup?: Parameters<typeof saveAlerts>[5],
): Promise<ActionResult<true>> {
	if (!visible(ctx)) return refuse(409, NOT_AVAILABLE);
	const result = await saveAlerts(db, person(ctx.viewer), zip, Number(rawRadius), ctx.now, lookup);
	return result.ok ? { ok: true, value: true } : refuse(400, result.message);
}

/** Turn them off (FR-027). Allowed whatever the setting: nobody should be
 *  unable to stop messages. */
export async function stopAlertsAction(db: Db, ctx: PanelContext): Promise<ActionResult<true>> {
	await stopAlerts(db, ctx.viewer.slackUserId);
	return { ok: true, value: true };
}
