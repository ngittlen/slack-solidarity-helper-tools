import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { agreeToGuidelines, createWalk, loadWalk } from './store.js';
import { answerWalk, heldSeats, joinWalk } from './seats.js';
import { eq } from 'drizzle-orm';
import { mentorWalks } from '../schema.js';
import { postNoShows, postPendingNoShows, type NoShowDeps } from './no-show.js';

let db: ReturnType<typeof drizzle>;

const NOW = new Date('2026-10-18T16:00:00.000Z');
const AFTER = new Date(NOW.getTime() + 3 * 3_600_000);
const MENTOR = { id: 'U_MENTOR', name: 'Jessica T.' };
const PRIYA = { id: 'U_PRIYA', name: 'Priya K.' };
const DEV = { id: 'google:dev', name: 'Dev M.' };

const post = vi.fn<NoShowDeps['post']>();
const deps = (channelId = 'C_TURF'): NoShowDeps => ({
	post,
	channelId,
	chapterName: () => 'Oakland County',
	appUrl: 'https://turf.example.org',
});

let walkId: number;

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	db = drizzle(createClient({ url: ':memory:' }));
	await migrate(db, { migrationsFolder: 'drizzle' });
	post.mockReset();
	post.mockImplementation(async (_c, _t, _l, threadTs) => (threadTs ? 'reply.ts' : '1111.2222'));
	await agreeToGuidelines(db, MENTOR, 'https://example.org/g', NOW);
	const walk = await createWalk(
		db,
		MENTOR,
		{
			chapterId: 72,
			startsAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
			place: 'Royal Oak Farmers Market',
			lat: 42.49,
			lng: -83.14,
			note: '',
			lookFor: 'Campaign merch',
			seats: 2,
			phone: '',
		},
		NOW,
	);
	if (!walk.ok) throw new Error(walk.message);
	walkId = walk.id;
	await joinWalk(db, PRIYA, walkId, true, NOW);
	await joinWalk(db, DEV, walkId, true, NOW);
});

describe('no-show reports', () => {
	it('posts the first report, and threads the second under it', async () => {
		await answerWalk(db, PRIYA.id, walkId, 'no-show', AFTER);
		await postNoShows(db, walkId, deps());
		await answerWalk(db, DEV.id, walkId, 'no-show', AFTER);
		await postNoShows(db, walkId, deps());
		await postNoShows(db, walkId, deps());

		expect(post).toHaveBeenCalledTimes(2);
		const [first, second] = post.mock.calls;
		expect(first[0]).toBe('C_TURF');
		expect(first[1]).toContain(':warning: *Mentor walk no-show reported* by Priya K.');
		expect(first[1]).toContain('Mentor: *Jessica T.* · Oakland County');
		expect(first[3]).toBeUndefined();
		expect(second).toEqual(['C_TURF', 'Also reported by Dev M.', '[mentor-walks]', '1111.2222']);
		expect(await loadWalk(db, walkId)).toMatchObject({ noShowTs: '1111.2222' });
	});

	it('records the report with no channel set, and posts nothing', async () => {
		await answerWalk(db, PRIYA.id, walkId, 'no-show', AFTER);
		await postNoShows(db, walkId, deps(''));
		expect(post).not.toHaveBeenCalled();
		const seats = (await heldSeats(db, [walkId])).get(walkId) ?? [];
		expect(seats.find((s) => s.holderId === PRIYA.id)?.answer).toBe('no-show');
	});

	it('tries a failed post again on the next sweep', async () => {
		await answerWalk(db, PRIYA.id, walkId, 'no-show', AFTER);
		post.mockResolvedValueOnce(null);
		await postNoShows(db, walkId, deps());
		expect(await loadWalk(db, walkId)).toMatchObject({ noShowTs: null, noShowChannel: null });
		await postPendingNoShows(db, AFTER, deps());
		expect(post).toHaveBeenCalledTimes(2);
		expect(await loadWalk(db, walkId)).toMatchObject({ noShowTs: '1111.2222' });
	});

	it('takes over a claim left by a server that stopped mid-post, once it is stale', async () => {
		await answerWalk(db, PRIYA.id, walkId, 'no-show', AFTER);
		const claim = (minutesAgo: number) =>
			db
				.update(mentorWalks)
				.set({
					noShowChannel: 'C_TURF',
					noShowClaimedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
				})
				.where(eq(mentorWalks.id, walkId));
		await claim(1);
		await postPendingNoShows(db, AFTER, deps());
		expect(post).not.toHaveBeenCalled();
		await claim(11);
		await postPendingNoShows(db, AFTER, deps());
		expect(post).toHaveBeenCalledTimes(1);
		expect(await loadWalk(db, walkId)).toMatchObject({ noShowTs: '1111.2222' });
	});
});
