import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
	agree,
	answerInvitation,
	cancelOwnWalk,
	GEOCODER_UNAVAILABLE,
	GUIDELINES_CHANGED,
	loadMentorDebug,
	loadMentorPanel,
	locatePlace,
	PLACE_NOT_FOUND,
	PLACE_NOT_LOCATED,
	saveWalk,
	type WalkForm,
} from './panel.js';
import { appointMentor, forgetMentor, listMentorWalks, loadMentor, revokeMentor } from './store.js';
import type { MentorWalksVisibility } from '../../mentor-walks/rules.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-10-18T16:00:00.000Z');
const URL_A = 'https://example.org/guidelines';
const CHAPTERS = [{ chapterId: 71, name: 'Washtenaw County' }];
const VOLUNTEER = { slackUserId: 'U_VOL', slackUserName: 'Kimberly R.', isAdmin: false };
const ADMIN = { id: 'U_ADMIN', name: 'Alex' };

const ctx = (
	over: {
		visibility?: MentorWalksVisibility;
		url?: string;
		blocked?: boolean;
		viewer?: typeof VOLUNTEER & { isModerator?: boolean; mentorSimulation?: true };
	} = {},
) => ({
	viewer: over.viewer ?? VOLUNTEER,
	settings: {
		mentorWalksVisibility: over.visibility ?? 'everyone',
		volunteerGuidelinesUrl: over.url ?? URL_A,
	},
	blocked: over.blocked ?? false,
	now: NOW,
	chapters: CHAPTERS,
	chapterNames: new Map([
		[71, 'Washtenaw County'],
		[72, 'Hidden County'],
	]),
	chapterIds: [71],
});

/** Agree to the link the page shows. */
const agreeTo = (c: ReturnType<typeof ctx>, ticked = true) =>
	agree(db, c, ticked, c.settings.volunteerGuidelinesUrl);

const form = (over: Partial<WalkForm> = {}): WalkForm => ({
	walkId: null,
	chapterId: '71',
	date: '2026-10-20',
	time: '14:00',
	place: 'Ypsilanti District Library, 229 W Michigan Ave',
	lat: '42.24',
	lng: '-83.61',
	note: 'By the front doors',
	seats: '3',
	phone: '734 555 0142',
	...over,
});

async function completeTurfs(n: number) {
	for (let i = 0; i < n; i++) {
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, completed_at)
			      VALUES (?, 'U_VOL', 'K', ?, ?, ?)`,
			args: [i, NOW.toISOString(), NOW.toISOString(), NOW.toISOString()],
		});
	}
}

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('loadMentorPanel', () => {
	it('invites someone with 4 completed turfs', async () => {
		await completeTurfs(4);
		expect(await loadMentorPanel(db, ctx())).toEqual({ state: 'invite', guidelinesUrl: URL_A });
	});

	it('shows nothing to someone not yet eligible', async () => {
		await completeTurfs(3);
		expect(await loadMentorPanel(db, ctx())).toBeNull();
	});

	it('shows nothing when off, blocked, or staff-only for a volunteer', async () => {
		await completeTurfs(4);
		expect(await loadMentorPanel(db, ctx({ visibility: 'off' }))).toBeNull();
		expect(await loadMentorPanel(db, ctx({ blocked: true }))).toBeNull();
		expect(await loadMentorPanel(db, ctx({ visibility: 'staff' }))).toBeNull();
		const moderator = { ...VOLUNTEER, isModerator: true };
		expect(await loadMentorPanel(db, ctx({ visibility: 'staff', viewer: moderator }))).toEqual({
			state: 'invite',
			guidelinesUrl: URL_A,
		});
	});

	it('invites nobody until the guidelines link is set', async () => {
		await completeTurfs(4);
		expect(await loadMentorPanel(db, ctx({ url: '' }))).toBeNull();
	});

	it('asks an appointed mentor to agree first', async () => {
		await appointMentor(
			db,
			{ id: VOLUNTEER.slackUserId, name: VOLUNTEER.slackUserName },
			ADMIN,
			NOW,
		);
		expect((await loadMentorPanel(db, ctx()))?.state).toBe('agree');
	});
});

describe('the invitation', () => {
	beforeEach(() => completeTurfs(4));

	it('snoozes, and refuses a second answer while snoozed', async () => {
		expect(await answerInvitation(db, ctx(), 'snooze')).toEqual({ ok: true, value: 'snooze' });
		expect(await loadMentorPanel(db, ctx())).toBeNull();
		expect((await answerInvitation(db, ctx(), 'decline')).ok).toBe(false);
	});

	it('leaves the way back open after No thanks', async () => {
		await answerInvitation(db, ctx(), 'decline');
		expect((await loadMentorPanel(db, ctx()))?.state).toBe('declined');
		expect(await agreeTo(ctx())).toEqual({ ok: true, value: true });
		expect((await loadMentorPanel(db, ctx()))?.state).toBe('mentor');
	});

	it('needs the box ticked to agree', async () => {
		expect((await agreeTo(ctx(), false)).ok).toBe(false);
		expect(await loadMentor(db, VOLUNTEER.slackUserId)).toBeNull();
	});

	it('records the link they were shown, and asks again if it has changed', async () => {
		const OLD = 'https://example.org/guidelines-old';
		expect(await agree(db, ctx(), true, OLD)).toEqual({
			ok: false,
			status: 409,
			message: GUIDELINES_CHANGED,
		});
		expect(await loadMentor(db, VOLUNTEER.slackUserId)).toMatchObject({
			status: 'active',
			agreedUrl: OLD,
		});
		expect((await loadMentorPanel(db, ctx()))?.state).toBe('agree');
	});

	it('asks again when the guidelines link changes', async () => {
		await agreeTo(ctx());
		const v2 = ctx({ url: 'https://example.org/guidelines-v2' });
		expect((await loadMentorPanel(db, v2))?.state).toBe('agree');
		expect((await saveWalk(db, v2, form())).ok).toBe(false);
	});

	it('keeps their walks in reach while asking again, and lets them cancel one', async () => {
		await agreeTo(ctx());
		const saved = await saveWalk(db, ctx(), form());
		if (!saved.ok) throw new Error('save failed');
		const v2 = ctx({ url: 'https://example.org/guidelines-v2' });
		const panel = await loadMentorPanel(db, v2);
		expect(panel?.state).toBe('agree');
		expect(panel && 'walks' in panel ? panel.walks.map((w) => w.id) : []).toEqual([
			String(saved.value),
		]);
		expect(await cancelOwnWalk(db, v2, String(saved.value))).toEqual({
			ok: true,
			value: saved.value,
		});
	});
});

describe('locatePlace', () => {
	const lookup = (kind: 'found' | 'not-found' | 'unavailable') => async () =>
		kind === 'found'
			? {
					kind,
					point: { lat: 42.24, lng: -83.61 },
					zip: '48197',
					matchedAddress: '229 W MICHIGAN AVE, YPSILANTI, MI, 48197',
				}
			: { kind };

	beforeEach(async () => {
		await completeTurfs(4);
		await agreeTo(ctx());
	});

	it('answers with the point and the address it matched', async () => {
		expect(await locatePlace(db, ctx(), '229 W Michigan Ave', lookup('found'))).toEqual({
			ok: true,
			value: {
				point: { lat: 42.24, lng: -83.61 },
				matchedAddress: '229 W MICHIGAN AVE, YPSILANTI, MI, 48197',
			},
		});
	});

	it('tells an unknown address apart from the geocoder being down', async () => {
		expect(await locatePlace(db, ctx(), 'Riverside Park', lookup('not-found'))).toEqual({
			ok: false,
			status: 400,
			message: PLACE_NOT_FOUND,
		});
		expect(await locatePlace(db, ctx(), '229 W Michigan Ave', lookup('unavailable'))).toEqual({
			ok: false,
			status: 503,
			message: GEOCODER_UNAVAILABLE,
		});
	});

	it('is only for mentors, and never sends an empty place', async () => {
		const geocode = vi.fn(lookup('found'));
		expect((await locatePlace(db, ctx(), '  ', geocode)).ok).toBe(false);
		const stranger = { ...VOLUNTEER, slackUserId: 'U_NOBODY' };
		expect((await locatePlace(db, ctx({ viewer: stranger }), 'x 1', geocode)).ok).toBe(false);
		expect(geocode).not.toHaveBeenCalled();
	});
});

describe('walks', () => {
	beforeEach(async () => {
		await completeTurfs(4);
		await agreeTo(ctx());
	});

	it('posts a walk and shows it with the phone pre-filled', async () => {
		const result = await saveWalk(db, ctx(), form());
		expect(result.ok).toBe(true);
		const panel = await loadMentorPanel(db, ctx());
		if (panel?.state !== 'mentor') throw new Error('not a mentor');
		expect(panel.defaultPhone).toBe('(734) 555-0142');
		expect(panel.walks).toHaveLength(1);
		expect(panel.walks[0]).toMatchObject({
			place: 'Ypsilanti District Library, 229 W Michigan Ave',
			seats: 3,
			draft: { chapterId: 71, date: '2026-10-20', time: '14:00', note: 'By the front doors' },
		});
	});

	it('needs the place found on the map', async () => {
		expect(await saveWalk(db, ctx(), form({ lat: '', lng: '' }))).toEqual({
			ok: false,
			status: 400,
			problems: [PLACE_NOT_LOCATED],
		});
		expect((await saveWalk(db, ctx(), form({ lat: '91', lng: '0' }))).ok).toBe(false);
	});

	it('lists every problem at once', async () => {
		const result = await saveWalk(db, ctx(), form({ date: '', seats: '9', chapterId: '5' }));
		expect(result).toEqual({
			ok: false,
			status: 400,
			problems: [
				'Pick a chapter.',
				'Pick a date and start time.',
				'Open seats must be between 1 and 6.',
			],
		});
	});

	it('keeps a walk in a chapter /turfs has stopped offering', async () => {
		const created = await saveWalk(db, ctx(), form());
		if (!created.ok) throw new Error('save failed');
		await client.execute(`UPDATE mentor_walks SET chapter_id = 72 WHERE id = ${created.value}`);
		const panel = await loadMentorPanel(db, ctx());
		if (panel?.state !== 'mentor') throw new Error('not a mentor');
		expect(panel.walks[0]).toMatchObject({
			chapterName: 'Hidden County',
			draft: { chapterId: 72, point: { lat: 42.24, lng: -83.61 } },
		});
		const kept = form({ walkId: String(created.value), chapterId: '72', seats: '4' });
		expect(await saveWalk(db, ctx(), kept)).toEqual({ ok: true, value: created.value });
		// But a new walk can't be posted there.
		expect((await saveWalk(db, ctx(), form({ chapterId: '72', time: '18:00' }))).ok).toBe(false);
	});

	it('edits only the mentor’s own walk', async () => {
		const created = await saveWalk(db, ctx(), form());
		if (!created.ok) throw new Error('save failed');
		const edited = await saveWalk(db, ctx(), form({ walkId: String(created.value), seats: '5' }));
		expect(edited).toEqual({ ok: true, value: created.value });

		const other = { ...VOLUNTEER, slackUserId: 'U_OTHER' };
		await appointMentor(db, { id: 'U_OTHER', name: 'Other' }, ADMIN, NOW);
		await agreeTo(ctx({ viewer: other }));
		const stolen = await saveWalk(
			db,
			ctx({ viewer: other }),
			form({ walkId: String(created.value) }),
		);
		expect(stolen).toEqual({ ok: false, status: 404, message: 'That walk no longer exists.' });
	});

	it('cancels a walk, and a revoked mentor can do nothing', async () => {
		const created = await saveWalk(db, ctx(), form());
		if (!created.ok) throw new Error('save failed');
		expect(await cancelOwnWalk(db, ctx(), String(created.value))).toEqual({
			ok: true,
			value: created.value,
		});
		expect(await listMentorWalks(db, VOLUNTEER.slackUserId, NOW)).toEqual([]);

		await revokeMentor(db, VOLUNTEER.slackUserId, ADMIN, NOW);
		expect(await loadMentorPanel(db, ctx())).toBeNull();
		expect((await saveWalk(db, ctx(), form())).ok).toBe(false);
		expect((await agreeTo(ctx())).ok).toBe(false);
	});
});

describe('admin simulation', () => {
	const SIMULATING = {
		slackUserId: 'U_ADMIN',
		slackUserName: 'Alex',
		isAdmin: true,
		mentorSimulation: true as const,
	};

	it('invites an admin with no record, whatever the setting', async () => {
		const sim = ctx({ visibility: 'off', viewer: SIMULATING });
		expect(await loadMentorPanel(db, sim)).toEqual({ state: 'invite', guidelinesUrl: URL_A });
		expect(await agreeTo(sim)).toEqual({ ok: true, value: true });
		expect((await saveWalk(db, sim, form())).ok).toBe(true);
		expect((await loadMentorPanel(db, sim))?.state).toBe('mentor');
	});

	it('is ignored for anyone but an admin', async () => {
		const notAdmin = { ...SIMULATING, isAdmin: false };
		expect(await loadMentorPanel(db, ctx({ viewer: notAdmin }))).toBeNull();
		expect(await loadMentorDebug(db, ctx({ viewer: notAdmin }))).toBeNull();
	});

	it('starts over by forgetting status and calling off walks', async () => {
		const sim = ctx({ viewer: SIMULATING });
		await agreeTo(sim);
		await saveWalk(db, sim, form());
		await forgetMentor(db, { id: 'U_ADMIN', name: 'Alex' }, NOW);
		expect(await loadMentor(db, 'U_ADMIN')).toBeNull();
		expect(await listMentorWalks(db, 'U_ADMIN', NOW)).toEqual([]);
		expect(await loadMentorDebug(db, sim)).toEqual({
			simulating: true,
			status: 'not invited',
			visibility: 'everyone',
			guidelinesSet: true,
			completed: 0,
			doors: 0,
		});
	});
});
