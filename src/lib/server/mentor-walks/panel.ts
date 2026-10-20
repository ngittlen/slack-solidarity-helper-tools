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
	featureVisible,
	isEligible,
	mentorPanelState,
	needsEligibility,
	normalizePhone,
	PLACE_MAX_LENGTH,
	validateWalk,
	walkInputsFromStart,
	walkStartFromInputs,
	type MentorPanelState,
} from '../../mentor-walks/rules.js';
import type {
	ChapterOption,
	MentorDebugView,
	MentorPanelView,
	PlaceLocation,
} from '../../mentor-walks/types.js';
import { campaignDayLabel, campaignTimeLabel } from '../../campaign-time.js';
import { errMessage } from '../../err-message.js';

export type { MentorDebugView };

type Db = ReturnType<typeof drizzle>;

type Viewer = Pick<
	SessionData,
	'slackUserId' | 'slackUserName' | 'isAdmin' | 'isModerator' | 'mentorSimulation'
>;

interface PanelContext {
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
		if (state !== 'mentor') return { state, guidelinesUrl };

		const id = ctx.viewer.slackUserId;
		const [walks, stats, defaultPhone] = await Promise.all([
			listMentorWalks(db, id, ctx.now),
			mentorStats(db, id, ctx.now),
			latestPhone(db, id),
		]);
		return {
			state,
			guidelinesUrl,
			walks: walks.map((w) => ({
				id: String(w.id),
				dayLabel: campaignDayLabel(w.startsAt),
				timeLabel: campaignTimeLabel(w.startsAt),
				place: w.place,
				seats: w.seats,
				// US3: the names of the people holding seats.
				joined: [],
				chapterName: ctx.chapterNames.get(w.chapterId) ?? `Chapter ${w.chapterId}`,
				draft: {
					chapterId: w.chapterId,
					...walkInputsFromStart(w.startsAt),
					place: w.place,
					point: { lat: w.lat, lng: w.lng },
					note: w.note ?? '',
					seats: w.seats,
					phone: w.phone ?? '',
				},
			})),
			...stats,
			defaultPhone,
			chapters: ctx.chapters,
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
): Promise<ActionResult<number> | { ok: false; status: 400; problems: string[] }> {
	if ((await panelState(db, ctx)) !== 'mentor') return refuse(409, NOT_AVAILABLE);
	const mentorId = ctx.viewer.slackUserId;

	const walkId = form.walkId ? Number(form.walkId) : null;
	let chapterIds = ctx.chapterIds;
	if (walkId !== null) {
		const existing = Number.isInteger(walkId) ? await loadWalk(db, walkId) : null;
		if (!existing || existing.mentorId !== mentorId)
			return refuse(404, 'That walk no longer exists.');
		// A walk keeps its chapter even if /turfs has stopped offering it since.
		chapterIds = [...chapterIds, existing.chapterId];
	}

	const input = {
		chapterId: Number(form.chapterId),
		startsAt: walkStartFromInputs(form.date, form.time),
		place: form.place.trim(),
		note: form.note.trim(),
		seats: Number(form.seats),
		phone: form.phone,
	};
	const problems = validateWalk(input, {
		now: ctx.now,
		// US3: the number of seats taken.
		seatsTaken: 0,
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
		seats: input.seats,
		phone: normalizePhone(input.phone) ?? '',
	};
	const result =
		walkId === null
			? await createWalk(db, person(ctx.viewer), fields, ctx.now)
			: await updateWalk(db, mentorId, walkId, fields, ctx.now);
	if (!result.ok) return { ok: false, status: 400, problems: [result.message] };
	return { ok: true, value: result.id };
}

/** The mentor calls a walk off (FR-010). Allowed for any active mentor, even
 *  one who has to agree to new guidelines before hosting again. */
export async function cancelOwnWalk(
	db: Db,
	ctx: PanelContext,
	rawId: string,
): Promise<ActionResult<number>> {
	if (!visible(ctx)) {
		return refuse(409, NOT_AVAILABLE);
	}
	const row = await loadMentor(db, ctx.viewer.slackUserId);
	if (row?.status !== 'active') return refuse(409, NOT_AVAILABLE);
	const id = Number(rawId);
	if (!Number.isInteger(id) || !(await cancelWalk(db, person(ctx.viewer), id, ctx.now))) {
		return refuse(409, 'That walk has already started or was cancelled.');
	}
	return { ok: true, value: id };
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
