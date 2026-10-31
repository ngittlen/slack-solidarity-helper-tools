// One writer for a run's turfs: their writes, committed a few turfs at a time.
//
// Measured on Turso (2026-10-12): a turf's whole write — hull, ~150 roster
// rows, done row — takes ~0.1s alone, of which ~60ms is the round trip. Yet in
// the drain it averaged 1.4s, and an outside write waited 4–15s while a drain
// ran, against ~40ms once it stopped. The time was in the queue for SQLite's
// one write lock, not the writes: two workers each taking it two or three
// times a turf, the export webhook and Fly's own jobs all contending for it,
// a busy writer retrying on a backoff while a newer one slips in ahead.
//
// So a run gets one writer, with at most one transaction in flight. Writes
// handed to it while that one runs wait, and go together in the next: the more
// the database lags, the more each transaction carries, and the turfs never
// queue for the lock behind each other — only this writer does. A bigger
// transaction costs little more: the rows were ~2ms each against the round
// trip and the wait.
//
// Each `write` is one group: statements that must land together and in order,
// usually one turf's. Groups are committed in the order they were handed in.
// If a transaction carrying several fails, each group is retried on its own,
// so one turf's bad write fails that turf and not the others it travelled
// with.

import type { drizzle } from 'drizzle-orm/libsql';

type Db = ReturnType<typeof drizzle>;
type Statements = Parameters<Db['batch']>[0];

/** Groups per transaction, at most. Bounds one request's size: a turf's group
 *  is a few hundred roster rows of two 16-byte hashes. */
const MAX_GROUPS_PER_TRANSACTION = 50;

export interface GroupWriteOptions {
	/** Roster rows the group inserts, for the write-time fit. */
	rows?: number;
	/** The group is a finished turf's result, rather than a claim, a job id or
	 *  a failure. Counted, to say how many turfs a transaction carried. */
	turf?: boolean;
}

/** The committed transactions, for the run's timings. A failed one counts
 *  nowhere, so the fit is over complete writes. */
export interface GroupWriterStats {
	transactions: number;
	ms: number;
	turfs: number;
	rows: number;
	rowsSq: number;
	rowsMs: number;
}

interface Group extends Required<GroupWriteOptions> {
	statements: unknown[];
	resolve: () => void;
	reject: (err: unknown) => void;
}

export interface GroupWriter {
	/** Queue one group. Resolves once it is committed, rejects if it could
	 *  not be. Never empty: a group needs at least one statement. */
	write(statements: unknown[], options?: GroupWriteOptions): Promise<void>;
	/** Resolves once fewer than `limit` groups are waiting, so a run that
	 *  outpaces the database slows down rather than piling up rosters. */
	room(limit: number): Promise<void>;
	/** Resolves once everything handed in so far is committed or failed. */
	idle(): Promise<void>;
	stats: GroupWriterStats;
}

export function createGroupWriter(db: Db): GroupWriter {
	const waiting: Group[] = [];
	const stats: GroupWriterStats = {
		transactions: 0,
		ms: 0,
		turfs: 0,
		rows: 0,
		rowsSq: 0,
		rowsMs: 0,
	};
	let pumping: Promise<void> | null = null;
	/** Woken after every transaction, for `room`. */
	let afterTransaction: Array<() => void> = [];

	async function commit(groups: Group[]): Promise<void> {
		const started = Date.now();
		await db.batch(groups.flatMap((g) => g.statements) as unknown as Statements);
		const ms = Date.now() - started;
		const rows = groups.reduce((n, g) => n + g.rows, 0);
		stats.transactions++;
		stats.ms += ms;
		stats.turfs += groups.filter((g) => g.turf).length;
		stats.rows += rows;
		stats.rowsSq += rows * rows;
		stats.rowsMs += rows * ms;
	}

	async function pump(): Promise<void> {
		while (waiting.length > 0) {
			const groups = waiting.splice(0, MAX_GROUPS_PER_TRANSACTION);
			try {
				await commit(groups);
				for (const g of groups) g.resolve();
			} catch (err) {
				if (groups.length === 1) groups[0]!.reject(err);
				else {
					for (const g of groups) {
						try {
							await commit([g]);
							g.resolve();
						} catch (own) {
							g.reject(own);
						}
					}
				}
			}
			const wake = afterTransaction;
			afterTransaction = [];
			for (const w of wake) w();
		}
	}

	/** Start the pump unless it is running. Restarted from its own `finally`
	 *  for a write that arrived after its last look at the queue but before it
	 *  cleared `pumping`, which would otherwise wait for a write that never
	 *  comes. */
	function kick(): void {
		if (pumping) return;
		pumping = pump().finally(() => {
			pumping = null;
			if (waiting.length > 0) kick();
		});
	}

	return {
		stats,
		write(statements, options = {}) {
			return new Promise<void>((resolve, reject) => {
				waiting.push({
					statements,
					rows: options.rows ?? 0,
					turf: options.turf ?? false,
					resolve,
					reject,
				});
				kick();
			});
		},
		async room(limit) {
			while (waiting.length >= Math.max(1, limit)) {
				await new Promise<void>((r) => afterTransaction.push(r));
			}
		},
		async idle() {
			while (pumping) await pumping;
		},
	};
}
