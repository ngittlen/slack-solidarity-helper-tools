import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { mentorWalkMessages } from '../schema.js';
import { agreeToGuidelines, createWalk, updateWalk, type WalkFields } from './store.js';
import { loadAlerts, queueAlerts, saveAlerts, stopAlerts, ZIP_NOT_FOUND } from './alerts.js';
import { joinWalk, leaveWalk } from './seats.js';

let db: ReturnType<typeof drizzle>;

const NOW = new Date('2026-10-18T16:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const APP = 'https://turf.example.org';
const MENTOR = { id: 'U_MENTOR', name: 'Kimberly R.' };
const SAM = { id: 'U_SAM', name: 'Sam R.' };

/** Ypsilanti's 48197, as the ZIP lookup would place it. */
const HOME = { lat: 42.2411, lng: -83.6129 };
/** About 5 and 20 miles east of HOME (a degree of longitude here is ~51 mi). */
const FIVE_MILES = { lat: HOME.lat, lng: HOME.lng + 5 / 51.3 };
const TWENTY_MILES = { lat: HOME.lat, lng: HOME.lng + 20 / 51.3 };
const lookup = vi.fn(async (_db: unknown, zip: string | null | undefined) =>
	zip === '48197' ? HOME : null,
);

const fields = (over: Partial<WalkFields> = {}): WalkFields => ({
	chapterId: 71,
	startsAt: at(26),
	place: 'Ypsilanti District Library, 229 W Michigan Ave',
	...FIVE_MILES,
	note: '',
	lookFor: 'Campaign merch',
	seats: 3,
	phone: '',
	...over,
});

async function postWalk(over: Partial<WalkFields> = {}, mentor = MENTOR): Promise<number> {
	const walk = await createWalk(db, mentor, fields(over), NOW);
	if (!walk.ok) throw new Error(walk.message);
	return walk.id;
}

async function alertsTo(holderId: string) {
	return db
		.select({
			walkId: mentorWalkMessages.walkId,
			status: mentorWalkMessages.status,
			text: mentorWalkMessages.text,
		})
		.from(mentorWalkMessages)
		.where(eq(mentorWalkMessages.holderId, holderId))
		.orderBy(mentorWalkMessages.id);
}

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	db = drizzle(createClient({ url: ':memory:' }));
	await migrate(db, { migrationsFolder: 'drizzle' });
	await agreeToGuidelines(db, MENTOR, 'https://example.org/g', NOW);
	await saveAlerts(db, SAM, '48197', 10, NOW, lookup);
});

describe('turning alerts on and off', () => {
	it('saves a ZIP it can find, and refuses one it can’t, leaving alerts as they were', async () => {
		expect(await loadAlerts(db, SAM.id)).toMatchObject({ zip: '48197', radiusMiles: 10 });
		expect(await saveAlerts(db, SAM, '00000', 25, NOW, lookup)).toEqual({
			ok: false,
			message: ZIP_NOT_FOUND,
		});
		expect(await saveAlerts(db, SAM, '48197', 7, NOW, lookup)).toEqual({
			ok: false,
			message: 'Pick 5, 10 or 25 miles.',
		});
		expect(await loadAlerts(db, SAM.id)).toMatchObject({ zip: '48197', radiusMiles: 10 });
		expect(await stopAlerts(db, SAM.id)).toBe(true);
		expect(await loadAlerts(db, SAM.id)).toBeNull();
	});
});

describe('queueAlerts', () => {
	it('alerts about a walk within the radius, not one beyond it', async () => {
		const near = await postWalk();
		await postWalk({ ...TWENTY_MILES, startsAt: at(40) });
		await queueAlerts(db, NOW, APP);
		const sent = await alertsTo(SAM.id);
		expect(sent.map((a) => a.walkId)).toEqual([near]);
		expect(sent[0].text).toContain('*Kimberly R.* is planning a walk near you');
		expect(sent[0].text).toContain('(5.0 mi)');
		expect(sent[0].text).toContain(`<${APP}/turfs?mentorAlerts=stop|Stop these alerts>`);
	});

	it('waits until the walk is within 3 days, then alerts once, edits or not', async () => {
		const id = await postWalk({ startsAt: at(5 * 24) });
		await queueAlerts(db, NOW, APP);
		expect(await alertsTo(SAM.id)).toEqual([]);
		await queueAlerts(db, later(2 * 24 + 1), APP);
		await updateWalk(
			db,
			MENTOR.id,
			id,
			fields({ startsAt: at(5 * 24), note: 'Changed' }),
			later(2 * 24 + 1),
		);
		await queueAlerts(db, later(2 * 24 + 2), APP);
		expect((await alertsTo(SAM.id)).map((a) => a.walkId)).toEqual([id]);
	});

	it('alerts someone a walk has been moved closer to', async () => {
		const id = await postWalk({ ...TWENTY_MILES });
		await queueAlerts(db, NOW, APP);
		expect(await alertsTo(SAM.id)).toEqual([]);
		await updateWalk(db, MENTOR.id, id, fields(), later(1));
		await queueAlerts(db, later(1), APP);
		expect((await alertsTo(SAM.id)).map((a) => a.walkId)).toEqual([id]);
	});

	it('sends at most 2 a day, and the next says how many more there were', async () => {
		const ids = [];
		for (let i = 0; i < 3; i++) ids.push(await postWalk({ startsAt: at(26 + i * 3) }));
		await queueAlerts(db, NOW, APP);
		expect((await alertsTo(SAM.id)).map((a) => a.status)).toEqual(['pending', 'pending', 'held']);

		const tomorrow = await postWalk({ startsAt: at(50) });
		await queueAlerts(db, later(24), APP);
		const sent = await alertsTo(SAM.id);
		expect(sent.map((a) => [a.walkId, a.status])).toEqual([
			[ids[0], 'pending'],
			[ids[1], 'pending'],
			[ids[2], 'summarized'],
			[tomorrow, 'pending'],
		]);
		expect(sent[3].text).toContain('And 1 more walk near you.');
	});

	it('never alerts a mentor about their own walk, a full walk, or one they’ve joined', async () => {
		await saveAlerts(db, MENTOR, '48197', 10, NOW, lookup);
		const full = await postWalk({ seats: 1 }, { id: 'U_OTHER', name: 'Sara G.' });
		await agreeToGuidelines(db, { id: 'U_OTHER', name: 'Sara G.' }, 'https://example.org/g', NOW);
		await joinWalk(db, { id: 'U_DEV', name: 'Dev M.' }, full, true, NOW);
		const joined = await postWalk({ startsAt: at(40) }, { id: 'U_OTHER', name: 'Sara G.' });
		await joinWalk(db, SAM, joined, true, NOW);
		const own = await postWalk();
		await queueAlerts(db, NOW, APP);
		expect(await alertsTo(MENTOR.id)).toEqual([expect.objectContaining({ walkId: joined })]);
		expect((await alertsTo(SAM.id)).map((a) => a.walkId)).toEqual([own]);
	});

	it('doesn’t alert someone about a walk they joined and then gave up', async () => {
		const id = await postWalk();
		await joinWalk(db, SAM, id, true, NOW);
		await leaveWalk(db, SAM.id, id, NOW);
		await queueAlerts(db, NOW, APP);
		expect(await alertsTo(SAM.id)).toEqual([]);
	});
});
