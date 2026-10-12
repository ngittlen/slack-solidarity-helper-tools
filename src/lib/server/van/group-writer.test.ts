import { describe, it, expect } from 'vitest';
import { createGroupWriter } from './group-writer.js';

/** A db whose batch records what each transaction carried, and fails any
 *  transaction holding a statement named in `poison`. `hold` keeps every
 *  transaction open until released, so writes can pile up behind one. */
function makeDb(poison: string[] = []) {
	const transactions: string[][] = [];
	let release: (() => void) | null = null;
	let holding = false;
	const db = {
		batch: async (statements: string[]) => {
			if (holding) await new Promise<void>((r) => (release = r));
			if (statements.some((s) => poison.includes(s)))
				throw new Error(`bad ${statements.join(',')}`);
			transactions.push(statements);
			return [];
		},
	};
	return {
		db: db as never,
		transactions,
		hold: () => {
			holding = true;
		},
		letGo: () => {
			holding = false;
			release?.();
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createGroupWriter', () => {
	it('carries everything handed in during a transaction in the next, in order', async () => {
		const { db, transactions, hold, letGo } = makeDb();
		const writer = createGroupWriter(db);
		hold();
		const first = writer.write(['a1', 'a2'], { turf: true, rows: 3 });
		await tick();
		// Queued behind `a`, which is still open.
		const rest = [writer.write(['b'], { turf: true, rows: 4 }), writer.write(['c'])];
		letGo();
		await Promise.all([first, ...rest]);
		await writer.idle();

		expect(transactions).toEqual([
			['a1', 'a2'],
			['b', 'c'],
		]);
		expect(writer.stats).toMatchObject({ transactions: 2, turfs: 2, rows: 7, rowsSq: 9 + 16 });
	});

	it('fails only the group whose statement failed, not those it travelled with', async () => {
		const { db, transactions, hold, letGo } = makeDb(['bad']);
		const writer = createGroupWriter(db);
		hold();
		const first = writer.write(['a']);
		await tick();
		const good1 = writer.write(['b']);
		const bad = writer.write(['bad']);
		const good2 = writer.write(['c']);
		letGo();

		await expect(first).resolves.toBeUndefined();
		await expect(good1).resolves.toBeUndefined();
		await expect(bad).rejects.toThrow(/bad/);
		await expect(good2).resolves.toBeUndefined();
		// Tried together, then each on its own, still in order.
		expect(transactions).toEqual([['a'], ['b'], ['c']]);
		// The failed transaction counts nowhere.
		expect(writer.stats.transactions).toBe(3);
	});

	it('picks up a write that arrives as the last transaction finishes', async () => {
		const { db, transactions } = makeDb();
		const writer = createGroupWriter(db);
		const first = writer.write(['a']);
		// Queued from the first write's continuation: after the pump has seen
		// an empty queue, before it has cleared itself.
		const second = first.then(() => writer.write(['b']));
		await second;
		await writer.idle();
		expect(transactions.flat()).toEqual(['a', 'b']);
	});

	it('makes a caller wait for room once the backlog reaches the limit', async () => {
		const { db, hold, letGo } = makeDb();
		const writer = createGroupWriter(db);
		hold();
		void writer.write(['a']);
		await tick();
		void writer.write(['b']);
		void writer.write(['c']);

		let roomy = false;
		const waited = writer.room(2).then(() => (roomy = true));
		await tick();
		expect(roomy).toBe(false);
		letGo();
		await waited;
		expect(roomy).toBe(true);
		await writer.idle();
	});
});
