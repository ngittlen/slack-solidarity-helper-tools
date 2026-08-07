import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insertNote, recordDmOutcome, listNotes, type NewNoteInput } from './member-notes.js';

// Chained-builder stubs, following the dashboard-signups.test.ts pattern.
function makeDb(rankRows: { rank: number }[] = [{ rank: 1 }], insertedId = 42) {
	const returning = vi.fn().mockResolvedValue([{ id: insertedId }]);
	const values = vi.fn((row: Record<string, unknown>) => ({ returning, row }));
	const insert = vi.fn(() => ({ values }));

	const selectWhere = vi.fn().mockResolvedValue(rankRows);
	const selectFrom = vi.fn(() => ({ where: selectWhere }));
	const select = vi.fn(() => ({ from: selectFrom }));

	const updateWhere = vi.fn().mockResolvedValue(undefined);
	const set = vi.fn((patch: Record<string, unknown>) => ({ where: updateWhere, patch }));
	const update = vi.fn(() => ({ set }));

	const orderBy = vi.fn().mockResolvedValue([{ id: 1 }]);
	const listWhere = vi.fn(() => ({ orderBy }));

	return {
		db: { insert, select, update } as never,
		spies: {
			insert,
			values,
			returning,
			select,
			selectWhere,
			update,
			set,
			updateWhere,
			orderBy,
			listWhere,
		},
	};
}

const input = (over: Partial<NewNoteInput> = {}): NewNoteInput => ({
	slackUserId: 'U_TARGET',
	kind: 'note',
	body: 'Details',
	messageLink: null,
	messageChannelId: null,
	messageTs: null,
	dmRequested: false,
	authorSlackUserId: 'U_ADMIN',
	authorSlackUserName: 'Admin',
	source: 'slash',
	...over,
});

beforeEach(() => vi.clearAllMocks());

describe('insertNote', () => {
	it('writes the row and stamps createdAt', async () => {
		const { db, spies } = makeDb();

		await insertNote(db, input());

		const written = spies.values.mock.calls[0]![0] as Record<string, string>;
		expect(written).toMatchObject({ slackUserId: 'U_TARGET', kind: 'note', body: 'Details' });
		expect(Date.parse(written.createdAt)).not.toBeNaN();
	});

	it('does not rank a plain note', async () => {
		const { db, spies } = makeDb();

		const result = await insertNote(db, input({ kind: 'note' }));

		expect(result).toEqual({ id: 42, warningNumber: null });
		// No count query, no follow-up update.
		expect(spies.select).not.toHaveBeenCalled();
		expect(spies.update).not.toHaveBeenCalled();
	});

	// Insert-then-rank: the row goes in first, then its own position is counted.
	// Counting first would let two concurrent admins both be told "second".
	it('inserts before counting, then persists the rank', async () => {
		const order: string[] = [];
		const { db, spies } = makeDb([{ rank: 3 }]);
		spies.returning.mockImplementation(async () => {
			order.push('insert');
			return [{ id: 42 }];
		});
		spies.selectWhere.mockImplementation(async () => {
			order.push('count');
			return [{ rank: 3 }];
		});
		spies.updateWhere.mockImplementation(async () => {
			order.push('update');
		});

		const result = await insertNote(db, input({ kind: 'warning' }));

		expect(order).toEqual(['insert', 'count', 'update']);
		expect(result).toEqual({ id: 42, warningNumber: 3 });
		expect(spies.set).toHaveBeenCalledWith({ warningNumber: 3 });
	});

	it('returns the first warning as number 1', async () => {
		const { db } = makeDb([{ rank: 1 }]);
		expect((await insertNote(db, input({ kind: 'warning' }))).warningNumber).toBe(1);
	});

	it('returns the second warning as number 2', async () => {
		const { db } = makeDb([{ rank: 2 }]);
		expect((await insertNote(db, input({ kind: 'warning' }))).warningNumber).toBe(2);
	});

	it('falls back to 1 if the count comes back empty or unusable', async () => {
		for (const rows of [[], [{ rank: 0 }], [{ rank: Number.NaN }]]) {
			const { db } = makeDb(rows as { rank: number }[]);
			expect((await insertNote(db, input({ kind: 'warning' }))).warningNumber).toBe(1);
		}
	});

	it('carries the parsed message reference through', async () => {
		const { db, spies } = makeDb();

		await insertNote(
			db,
			input({
				messageLink: 'https://w.slack.com/archives/C1/p1712345678123456',
				messageChannelId: 'C1',
				messageTs: '1712345678.123456',
			}),
		);

		expect(spies.values.mock.calls[0]![0]).toMatchObject({
			messageChannelId: 'C1',
			messageTs: '1712345678.123456',
		});
	});

	it('records the admin’s DM choice', async () => {
		const { db, spies } = makeDb();
		await insertNote(db, input({ dmRequested: true }));
		expect(spies.values.mock.calls[0]![0]!.dmRequested).toBe(true);
	});
});

describe('recordDmOutcome', () => {
	it('stores a successful send with the exact body delivered', async () => {
		const { db, spies } = makeDb();

		await recordDmOutcome(db, 7, { sentAt: '2026-01-01T00:00:00Z', body: 'the message' });

		expect(spies.set).toHaveBeenCalledWith({
			dmSentAt: '2026-01-01T00:00:00Z',
			dmStatus: null,
			dmBody: 'the message',
		});
	});

	it('stores a failure reason with no sent timestamp', async () => {
		const { db, spies } = makeDb();

		await recordDmOutcome(db, 7, { status: 'user_not_found' });

		expect(spies.set).toHaveBeenCalledWith({
			dmSentAt: null,
			dmStatus: 'user_not_found',
			dmBody: null,
		});
	});
});

describe('listNotes', () => {
	it('queries newest-first for one member', async () => {
		const orderBy = vi.fn().mockResolvedValue([{ id: 2 }, { id: 1 }]);
		const where = vi.fn(() => ({ orderBy }));
		const from = vi.fn(() => ({ where }));
		const db = { select: vi.fn(() => ({ from })) } as never;

		const rows = await listNotes(db, 'U_TARGET');

		expect(rows).toHaveLength(2);
		expect(orderBy).toHaveBeenCalled();
	});
});
