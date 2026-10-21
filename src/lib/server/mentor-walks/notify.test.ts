import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mentorWalkMessages, mentorWalks } from '../schema.js';
import { newPublicId } from './store.js';
import {
	dispatchPending,
	enqueue,
	MAX_SEND_ATTEMPTS,
	type OutgoingMessage,
	type SendFn,
} from './notify.js';

// Who may hear about mentor walks comes from the settings and the block
// list; both are set per test.
const settings = vi.hoisted(() => ({
	mentorWalksVisibility: 'everyone' as 'off' | 'staff' | 'everyone',
	allowedSlackUserIds: new Set<string>(['U_ADMIN']),
	moderatorSlackUserIds: new Set<string>(['U_MOD']),
}));
const blocked = vi.hoisted(() => new Set<string>());
vi.mock('../settings.js', () => ({
	loadSettings: async () => settings,
	loadVanBlockedIds: async () => blocked,
}));

let db: ReturnType<typeof drizzle>;
const NOW = new Date('2026-10-18T16:00:00.000Z');
const send = vi.fn<SendFn>(async () => true);
const deps = { send, superuserId: 'U_SUPER' };

const message = (holderId: string, eventKey = 'off:1'): OutgoingMessage => ({
	holderId,
	walkId: 1,
	eventKey,
	kind: 'walk-off',
	text: 'The walk with *Kim* has been cancelled.',
});

async function statuses() {
	return db
		.select({ holderId: mentorWalkMessages.holderId, status: mentorWalkMessages.status })
		.from(mentorWalkMessages);
}

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	db = drizzle(createClient({ url: ':memory:' }));
	await migrate(db, { migrationsFolder: 'drizzle' });
	send.mockReset();
	send.mockResolvedValue(true);
	settings.mentorWalksVisibility = 'everyone';
	blocked.clear();
});

async function addWalk(startsAt: string, status: 'scheduled' | 'cancelled' = 'scheduled') {
	const [walk] = await db
		.insert(mentorWalks)
		.values({
			publicId: newPublicId(),
			mentorId: 'U_KIM',
			mentorName: 'Kim',
			chapterId: 71,
			startsAt,
			place: 'Library',
			lat: 42.2,
			lng: -83.7,
			seats: 3,
			status,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		})
		.returning();
	return walk.id;
}

const reminder = (holderId: string, walkId: number): OutgoingMessage => ({
	holderId,
	walkId,
	eventKey: `reminder:${walkId}`,
	kind: 'walk-reminder',
	text: 'Running late? Text Kim at (734) 555-0142.',
});

describe('the outbox', () => {
	it('queues an event once, and sends it once, however often it is processed', async () => {
		expect(await enqueue(db, [message('U_SAM')], NOW)).toBe(1);
		expect(await enqueue(db, [message('U_SAM')], NOW)).toBe(0);
		await dispatchPending(db, NOW, deps);
		await dispatchPending(db, NOW, deps);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			db,
			'U_SAM',
			'walk-off',
			'The walk with *Kim* has been cancelled.',
			'[mentor-walks]',
			NOW,
		);
		expect(await statuses()).toEqual([{ holderId: 'U_SAM', status: 'sent' }]);
	});

	it('sends a message once when two dispatchers run at the same moment', async () => {
		await enqueue(db, [message('U_SAM')], NOW);
		await Promise.all([dispatchPending(db, NOW, deps), dispatchPending(db, NOW, deps)]);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('at "Admins and moderators only", sends to them and skips everyone else', async () => {
		settings.mentorWalksVisibility = 'staff';
		await enqueue(
			db,
			['U_ADMIN', 'U_MOD', 'U_SUPER', 'U_SAM'].map((id) => message(id)),
			NOW,
		);
		expect(await dispatchPending(db, NOW, deps)).toEqual({ sent: 3, skipped: 1, failed: 0 });
		expect(send.mock.calls.map((c) => c[1])).toEqual(['U_ADMIN', 'U_MOD', 'U_SUPER']);
	});

	it('never sends to someone blocked, or to anyone when the feature is off', async () => {
		blocked.add('U_SAM');
		await enqueue(db, [message('U_SAM'), message('U_PRIYA')], NOW);
		await dispatchPending(db, NOW, { ...deps });
		expect(send.mock.calls.map((c) => c[1])).toEqual(['U_PRIYA']);

		settings.mentorWalksVisibility = 'off';
		await enqueue(db, [message('U_DEV')], NOW);
		await dispatchPending(db, NOW, deps);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('tries a failed send again, then gives up', async () => {
		send.mockResolvedValue(false);
		await enqueue(db, [message('U_SAM')], NOW);
		for (let i = 0; i < MAX_SEND_ATTEMPTS + 2; i++) await dispatchPending(db, NOW, deps);
		expect(send).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);
		expect(await statuses()).toEqual([{ holderId: 'U_SAM', status: 'failed' }]);
	});

	it('leaves a held alert unsent', async () => {
		await enqueue(
			db,
			[{ ...message('U_SAM', 'alert:1'), kind: 'walk-alert', status: 'held' }],
			NOW,
		);
		await dispatchPending(db, NOW, deps);
		expect(send).not.toHaveBeenCalled();
	});
});

describe('reminders', () => {
	it('go out before the walk, and never once it has started or is off', async () => {
		const soon = await addWalk('2026-10-18T18:00:00.000Z');
		const started = await addWalk('2026-10-18T15:00:00.000Z');
		const off = await addWalk('2026-10-18T18:00:00.000Z', 'cancelled');
		await enqueue(db, [reminder('U_A', soon), reminder('U_B', started), reminder('U_C', off)], NOW);
		await dispatchPending(db, NOW, deps);
		expect(send).toHaveBeenCalledTimes(1);
		expect(await statuses()).toEqual([
			{ holderId: 'U_A', status: 'sent' },
			{ holderId: 'U_B', status: 'skipped' },
			{ holderId: 'U_C', status: 'skipped' },
		]);
	});
});
