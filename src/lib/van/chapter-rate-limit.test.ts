import { describe, it, expect } from 'vitest';
import {
	recordChapterView,
	pruneVisitLog,
	chaptersSeen,
	CHAPTER_LOG_THRESHOLD,
	MAX_CHAPTER_SWITCHES,
	WINDOW_MS,
	type VisitLog,
} from './chapter-rate-limit.js';

const T0 = 1_700_000_000_000;

function freshLog(): VisitLog {
	return new Map();
}

describe('recordChapterView', () => {
	it('allows the first view', () => {
		expect(recordChapterView(freshLog(), 'U1', 71, T0)).toMatchObject({
			allowed: true,
			retryAfterSeconds: 0,
			distinctChapters: 1,
			shouldLog: false,
		});
	});

	it('allows up to the limit of distinct chapters', () => {
		const log = freshLog();
		for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) {
			expect(recordChapterView(log, 'U1', i, T0 + i).allowed).toBe(true);
		}
	});

	it('refuses the next distinct chapter', () => {
		const log = freshLog();
		for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) recordChapterView(log, 'U1', i, T0);
		const decision = recordChapterView(log, 'U1', 999, T0);
		expect(decision.allowed).toBe(false);
		expect(decision.retryAfterSeconds).toBeGreaterThan(0);
	});

	// The volunteer actually using the feature refreshes their own county's
	// page and bounces between the map and a claim. A limiter that counted page
	// views would throttle them while barely inconveniencing a script.
	it('never charges for re-opening a chapter already seen', () => {
		const log = freshLog();
		for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) recordChapterView(log, 'U1', i, T0);
		for (let n = 0; n < 50; n++) {
			expect(recordChapterView(log, 'U1', 3, T0 + n).allowed).toBe(true);
		}
	});

	it('lets the window roll off', () => {
		const log = freshLog();
		for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) recordChapterView(log, 'U1', i, T0);
		expect(recordChapterView(log, 'U1', 999, T0).allowed).toBe(false);
		expect(recordChapterView(log, 'U1', 999, T0 + WINDOW_MS + 1).allowed).toBe(true);
	});

	it('counts each user separately', () => {
		const log = freshLog();
		for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) recordChapterView(log, 'U1', i, T0);
		expect(recordChapterView(log, 'U1', 999, T0).allowed).toBe(false);
		expect(recordChapterView(log, 'U2', 999, T0).allowed).toBe(true);
	});

	it('reports how long until the window frees up', () => {
		const log = freshLog();
		for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) recordChapterView(log, 'U1', i, T0);
		// Half an hour into a one-hour window, ~30 minutes remain.
		const decision = recordChapterView(log, 'U1', 999, T0 + 30 * 60 * 1000);
		expect(decision.retryAfterSeconds).toBeGreaterThan(29 * 60);
		expect(decision.retryAfterSeconds).toBeLessThanOrEqual(30 * 60);
	});

	it('does not let a refused attempt consume a slot', () => {
		const log = freshLog();
		for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) recordChapterView(log, 'U1', i, T0);
		recordChapterView(log, 'U1', 999, T0);
		recordChapterView(log, 'U1', 998, T0);
		// The originals are still all that's recorded, so they roll off on time
		// rather than being pushed back by every rejected probe.
		expect(recordChapterView(log, 'U1', 0, T0 + 1).allowed).toBe(true);
	});
});

describe('logging threshold', () => {
	// The complaint this answers: a line every time a volunteer opened their
	// own county buried the handful of lines that meant something.
	it('does not log an ordinary one- or two-chapter session', () => {
		const log = freshLog();
		expect(recordChapterView(log, 'U1', 71, T0).shouldLog).toBe(false);
		expect(recordChapterView(log, 'U1', 72, T0).shouldLog).toBe(false);
	});

	it('never logs re-opening a chapter, however many times', () => {
		const log = freshLog();
		for (let i = 0; i < CHAPTER_LOG_THRESHOLD; i++) recordChapterView(log, 'U1', i, T0);
		for (let n = 0; n < 30; n++) {
			expect(recordChapterView(log, 'U1', 0, T0 + n).shouldLog).toBe(false);
		}
	});

	it('starts logging once the count is unusual', () => {
		const log = freshLog();
		const flags: boolean[] = [];
		for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) {
			flags.push(recordChapterView(log, 'U1', i, T0).shouldLog);
		}
		expect(flags.slice(0, CHAPTER_LOG_THRESHOLD - 1).every((f) => !f)).toBe(true);
		expect(flags.slice(CHAPTER_LOG_THRESHOLD - 1).every((f) => f)).toBe(true);
	});

	it('reports the running count for the log line', () => {
		const log = freshLog();
		recordChapterView(log, 'U1', 71, T0);
		expect(recordChapterView(log, 'U1', 72, T0).distinctChapters).toBe(2);
	});

	it('resets after the window, so a paced browser stays quiet', () => {
		// Stated honestly in the module: this buys quiet at the cost of
		// catching only the impatient.
		const log = freshLog();
		for (let i = 0; i < CHAPTER_LOG_THRESHOLD - 1; i++) {
			expect(recordChapterView(log, 'U1', i, T0).shouldLog).toBe(false);
		}
		const later = T0 + WINDOW_MS + 1;
		expect(recordChapterView(log, 'U1', 99, later).shouldLog).toBe(false);
	});
});

describe('chaptersSeen', () => {
	it('lists the window’s chapters oldest first', () => {
		const log = freshLog();
		recordChapterView(log, 'U1', 71, T0);
		recordChapterView(log, 'U1', 72, T0 + 10);
		recordChapterView(log, 'U1', 73, T0 + 20);
		expect(chaptersSeen(log, 'U1', T0 + 30)).toEqual([71, 72, 73]);
	});

	it('omits chapters that have aged out', () => {
		const log = freshLog();
		recordChapterView(log, 'U1', 71, T0);
		recordChapterView(log, 'U1', 72, T0 + WINDOW_MS);
		expect(chaptersSeen(log, 'U1', T0 + WINDOW_MS + 1)).toEqual([72]);
	});

	it('is empty for a user with no history', () => {
		expect(chaptersSeen(freshLog(), 'U_NOBODY', T0)).toEqual([]);
	});
});

describe('pruneVisitLog', () => {
	it('drops users whose visits have all aged out', () => {
		const log = freshLog();
		recordChapterView(log, 'U1', 71, T0);
		pruneVisitLog(log, T0 + WINDOW_MS + 1);
		expect(log.size).toBe(0);
	});

	it('keeps users with recent visits', () => {
		const log = freshLog();
		recordChapterView(log, 'U1', 71, T0);
		pruneVisitLog(log, T0 + 1000);
		expect(log.get('U1')).toHaveLength(1);
	});
});

// Admins are exempt: /turfs/organizer and the drift report already show every
// chapter at once, so capping the map at eight counties an hour withheld
// nothing while breaking launch-night work.
describe('admin exemption', () => {
	function fill(log: VisitLog, user: string, count: number, now: number) {
		for (let i = 0; i < count; i++) recordChapterView(log, user, 100 + i, now);
	}

	it('refuses a volunteer past the cap', () => {
		const log: VisitLog = new Map();
		const now = Date.now();
		fill(log, 'U1', MAX_CHAPTER_SWITCHES, now);
		expect(recordChapterView(log, 'U1', 999, now).allowed).toBe(false);
	});

	it('never refuses an exempt viewer, however many chapters they open', () => {
		const log: VisitLog = new Map();
		const now = Date.now();
		fill(log, 'U1', MAX_CHAPTER_SWITCHES, now);
		for (let i = 0; i < 40; i++) {
			const decision = recordChapterView(log, 'U1', 900 + i, now, { exempt: true });
			expect(decision.allowed).toBe(true);
		}
	});

	// Removing the throttle is not the same as removing the audit trail — an
	// admin sweeping every county must still show up in the log.
	it('still counts the view and still flags wide browsing', () => {
		const log: VisitLog = new Map();
		const now = Date.now();
		fill(log, 'U1', MAX_CHAPTER_SWITCHES, now);

		const decision = recordChapterView(log, 'U1', 999, now, { exempt: true });
		expect(decision.distinctChapters).toBe(MAX_CHAPTER_SWITCHES + 1);
		expect(decision.shouldLog).toBe(true);
	});

	it('leaves re-opening a chapter free for an exempt viewer too', () => {
		const log: VisitLog = new Map();
		const now = Date.now();
		recordChapterView(log, 'U1', 71, now, { exempt: true });
		const again = recordChapterView(log, 'U1', 71, now + 1000, { exempt: true });
		expect(again.distinctChapters).toBe(1);
		expect(again.shouldLog).toBe(false);
	});
});
