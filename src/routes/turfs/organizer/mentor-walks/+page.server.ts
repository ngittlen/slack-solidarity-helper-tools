// Organizer oversight of mentor walks (specs/015-mentor-walks, User Story 4):
// every walk, every mentor, and the controls to hide or cancel a walk and to
// make, revoke or reinstate a mentor. Admins only, like /turfs/organizer.
//
// Shown whatever the Mentor walks setting says, so an organizer can look
// things over before switching it on, and clean up after switching it off.

import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { getSlackUsers } from '$lib/server/autocomplete-sources.js';
import { loadBlockableOutsideVolunteers } from '$lib/server/outside-volunteers.js';
import { chaptersFromChannelMap } from '$lib/chapter-list.js';
import { campaignDayLabel, campaignTimeLabel } from '$lib/campaign-time.js';
import { errMessage } from '$lib/err-message.js';
import {
	appointMentor,
	campaignMetrics,
	listMentors,
	listWalksForOrganizer,
	loadMentor,
	loadWalkByPublicId,
	mentorTotals,
	reinstateMentor,
	revokeMentor,
	setWalkStatus,
} from '$lib/server/mentor-walks/store.js';
import { MENTOR_WALKS_VISIBILITY_LABELS } from '$lib/mentor-walks/rules.js';
import { heldSeats } from '$lib/server/mentor-walks/seats.js';
import { dispatchSoon } from '$lib/server/mentor-walks/dispatch.js';
import type {
	OrganizerMentorView,
	OrganizerPastWalkView,
	OrganizerWalkView,
	PersonOption,
} from '$lib/mentor-walks/types.js';

const DAY_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** Slack members and Google and Apple volunteers, as the block-list picker
 *  offers them. Never throws: without the list, Make mentor is unavailable but
 *  the rest of the page still works. */
async function loadPeople(): Promise<{ people: PersonOption[]; error: string | null }> {
	const [slackUsers, outside] = await Promise.allSettled([
		getSlackUsers(slack),
		loadBlockableOutsideVolunteers(db),
	]);
	const people: PersonOption[] = [];
	if (slackUsers.status === 'fulfilled') {
		for (const u of slackUsers.value.items) people.push({ id: u.id, name: u.name });
	}
	if (outside.status === 'fulfilled') {
		for (const v of outside.value) people.push({ id: v.userId, name: v.displayName });
	}
	const failed = [slackUsers, outside].filter((r) => r.status === 'rejected');
	for (const r of failed) {
		console.error('[mentor-walks] could not load people to appoint:', errMessage(r.reason));
	}
	people.sort((a, b) => a.name.localeCompare(b.name));
	return {
		people,
		error: failed.length > 0 ? 'Some people may be missing from the list. Try reloading.' : null,
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.isAdmin) redirect(302, '/');

	const now = new Date();
	const [settings, blockedIds, walks, mentorRows, totals, people, metrics] = await Promise.all([
		loadSettings(db),
		loadVanBlockedIds(db),
		listWalksForOrganizer(db, now),
		listMentors(db),
		mentorTotals(db, now),
		loadPeople(),
		campaignMetrics(db, now),
	]);
	const seats = await heldSeats(
		db,
		[...walks.upcoming, ...walks.past].map((w) => w.id),
	);
	const seatsOf = (id: number) => seats.get(id) ?? [];
	const chapterNames = new Map(
		chaptersFromChannelMap(settings.chapterChannelMap, settings.turfCustomChapters).map((c) => [
			c.chapterId,
			c.name,
		]),
	);
	const chapterName = (id: number) => chapterNames.get(id) ?? `Chapter ${id}`;

	const upcoming: OrganizerWalkView[] = walks.upcoming.map((w) => ({
		id: w.publicId,
		mentorName: w.mentorName,
		chapterName: chapterName(w.chapterId),
		dayLabel: campaignDayLabel(w.startsAt),
		timeLabel: campaignTimeLabel(w.startsAt),
		place: w.place,
		seats: w.seats,
		joined: seatsOf(w.id).map((s) => s.holderName),
		status: w.status,
		statusByName: w.statusByName,
	}));

	const past: OrganizerPastWalkView[] = walks.past.map((w) => ({
		id: w.publicId,
		mentorName: w.mentorName,
		chapterName: chapterName(w.chapterId),
		dayLabel: `${campaignDayLabel(w.startsAt)}, ${campaignTimeLabel(w.startsAt)}`,
		place: w.place,
		seats: w.seats,
		taken: seatsOf(w.id).length,
		attended: seatsOf(w.id).filter((s) => s.mentorTicked || s.answer === 'went').length,
		noShowReports: seatsOf(w.id).filter((s) => s.answer === 'no-show').length,
		status: w.status,
	}));

	const mentors: OrganizerMentorView[] = mentorRows.map((m) => {
		const total = totals.get(m.holderId);
		const lastChapter = total?.lastChapterId ?? null;
		const details = [
			m.appointedByName ? `appointed by ${m.appointedByName}` : null,
			m.status === 'revoked' && m.revokedAt
				? `revoked${m.revokedByName ? ` by ${m.revokedByName}` : ''} ${DAY_LABEL.format(new Date(m.revokedAt))}`
				: null,
			m.agreedUrl && m.agreedUrl !== settings.volunteerGuidelinesUrl
				? 'agreed to an older guidelines link'
				: null,
		].filter((d): d is string => d !== null);
		return {
			id: m.holderId,
			name: m.holderName,
			chapterName: lastChapter === null ? null : chapterName(lastChapter),
			status: m.status === 'revoked' ? 'revoked' : 'active',
			source: m.appointedBy ? 'organizer' : 'invited',
			agreedLabel: m.agreedAt ? DAY_LABEL.format(new Date(m.agreedAt)) : null,
			walksHosted: total?.walksHosted ?? 0,
			newPeopleTakenOut: total?.newPeopleTakenOut ?? 0,
			...(details.length > 0 ? { detail: details.join(' · ') } : {}),
		};
	});

	// Anyone not blocked and not already a mentor (revoked ones are reinstated
	// from their row instead).
	const taken = new Set(mentors.map((m) => m.id));
	const candidates = people.people.filter((p) => !taken.has(p.id) && !blockedIds.has(p.id));

	return {
		pageTitle: 'Mentor walks',
		visibilityLabel: MENTOR_WALKS_VISIBILITY_LABELS[settings.mentorWalksVisibility],
		guidelinesSet: settings.volunteerGuidelinesUrl !== '',
		upcoming,
		past,
		mentors,
		candidates,
		peopleError: people.error,
		metrics: {
			walksHosted: metrics.walksHosted,
			seatsOffered: metrics.seatsOffered,
			seatsTaken: metrics.seatsTaken,
			attendanceRate: percent(metrics.attendanceRate),
			noShowReports: metrics.noShowReports,
			completedOwnTurfWithin14Days: percent(metrics.followedOnRate),
		},
	};
};

/** "74%", or a dash before there's anything to measure. */
function percent(rate: number | null): string {
	return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function editorOf(session: NonNullable<App.Locals['session']>) {
	return { id: session.slackUserId, name: session.slackUserName };
}

async function formId(request: Request, key: string): Promise<string> {
	const value = (await request.formData()).get(key);
	return typeof value === 'string' ? value : '';
}

export const actions: Actions = {
	hideWalk: async ({ locals, request }) => {
		const session = locals.session;
		if (!session?.isAdmin) return fail(403, { walkError: 'Organizers only.' });
		const publicId = await formId(request, 'walkId');
		const walk = await loadWalkByPublicId(db, publicId);
		if (!walk || !(await setWalkStatus(db, walk.id, 'hidden', editorOf(session), new Date()))) {
			return fail(409, { walkError: 'That walk has already started, or was hidden or cancelled.' });
		}
		dispatchSoon(db);
		return { walkHidden: publicId };
	},

	cancelWalk: async ({ locals, request }) => {
		const session = locals.session;
		if (!session?.isAdmin) return fail(403, { walkError: 'Organizers only.' });
		const publicId = await formId(request, 'walkId');
		const walk = await loadWalkByPublicId(db, publicId);
		if (!walk || !(await setWalkStatus(db, walk.id, 'cancelled', editorOf(session), new Date()))) {
			return fail(409, { walkError: 'That walk has already started, or was hidden or cancelled.' });
		}
		dispatchSoon(db);
		return { walkCancelled: publicId };
	},

	makeMentor: async ({ locals, request }) => {
		const session = locals.session;
		if (!session?.isAdmin) return fail(403, { mentorError: 'Organizers only.' });
		const id = await formId(request, 'holderId');
		const [{ people }, blockedIds, existing] = await Promise.all([
			loadPeople(),
			loadVanBlockedIds(db),
			loadMentor(db, id),
		]);
		const person = people.find((p) => p.id === id);
		if (!person) return fail(404, { mentorError: 'We couldn’t find that person.' });
		if (blockedIds.has(id)) {
			return fail(409, { mentorError: `${person.name} is blocked from turf checkout.` });
		}
		if (existing?.status === 'active' || existing?.status === 'revoked') {
			return fail(409, { mentorError: `${person.name} is already on the mentor list.` });
		}
		if (!(await appointMentor(db, person, editorOf(session), new Date()))) {
			return fail(409, { mentorError: `${person.name} is already on the mentor list.` });
		}
		return { mentorMade: person.name };
	},

	revokeMentor: async ({ locals, request }) => {
		const session = locals.session;
		if (!session?.isAdmin) return fail(403, { mentorError: 'Organizers only.' });
		const id = await formId(request, 'holderId');
		const existing = await loadMentor(db, id);
		if (existing?.status !== 'active') {
			return fail(409, { mentorError: 'That person isn’t an active mentor.' });
		}
		const cancelled = await revokeMentor(db, id, editorOf(session), new Date());
		dispatchSoon(db);
		return { mentorRevoked: existing.holderName, walksCancelled: cancelled.length };
	},

	reinstateMentor: async ({ locals, request }) => {
		const session = locals.session;
		if (!session?.isAdmin) return fail(403, { mentorError: 'Organizers only.' });
		const id = await formId(request, 'holderId');
		const blockedIds = await loadVanBlockedIds(db);
		if (blockedIds.has(id)) {
			return fail(409, { mentorError: 'Unblock them from turf checkout first.' });
		}
		if (!(await reinstateMentor(db, id, editorOf(session), new Date()))) {
			return fail(409, { mentorError: 'That person isn’t a revoked mentor.' });
		}
		return { mentorReinstated: id };
	},
};
