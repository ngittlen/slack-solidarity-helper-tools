import { describe, it, expect } from 'vitest';
import { demoTurfs, DEMO_CHAPTERS, STRESS_CHAPTER_ID } from './demo-turfs.js';

describe('chapter scoping', () => {
	it('returns only the requested chapter', () => {
		for (const chapter of DEMO_CHAPTERS) {
			const turfs = demoTurfs(chapter.chapterId, { isAdmin: false });
			expect(turfs.length).toBeGreaterThan(0);
			expect(turfs.every((t) => t.chapterId === chapter.chapterId)).toBe(true);
		}
	});

	it('returns nothing for an unknown chapter', () => {
		expect(demoTurfs(-1, { isAdmin: false })).toEqual([]);
	});
});

describe('viewer redaction', () => {
	it('never sends a holder name to a volunteer', () => {
		const turfs = demoTurfs(71, { isAdmin: false });
		expect(turfs.every((t) => t.heldBy === null)).toBe(true);
	});

	// The strongest form of the guarantee: not "the template hides it" but
	// "the string is not in the payload at all".
	it('leaves no holder name anywhere in the serialised volunteer payload', () => {
		const json = JSON.stringify(demoTurfs(71, { isAdmin: false }));
		for (const name of ['Priya', 'Marcus', 'Dae-Ho', 'Renata']) {
			expect(json).not.toContain(name);
		}
	});

	it('does send holder names to an organizer', () => {
		const held = demoTurfs(71, { isAdmin: true }).filter((t) => t.status === 'checked-out');
		expect(held.length).toBeGreaterThan(0);
		expect(held.some((t) => t.heldBy !== null)).toBe(true);
	});

	// Regression: the stress fixture set heldBy on every row regardless of
	// status, so ~77% of its turfs rendered "Held by A volunteer" in the
	// organizer view while showing as available. Checked across every chapter
	// because the bug lived in one generator, not in the shared code.
	it('never attaches a holder or expiry to an available turf, in any chapter', () => {
		for (const chapter of DEMO_CHAPTERS) {
			const available = demoTurfs(chapter.chapterId, { isAdmin: true }).filter(
				(t) => t.status === 'available',
			);
			expect(available.length).toBeGreaterThan(0);
			expect(available.every((t) => t.heldBy === null)).toBe(true);
			expect(available.every((t) => t.expiresInHours === null)).toBe(true);
		}
	});

	it('collapses both taken states so a volunteer cannot tell them apart', () => {
		const turfs = demoTurfs(71, { isAdmin: false });
		expect(turfs.some((t) => t.status === 'checked-out')).toBe(true);
		// No countdown on other people's turf — only app claims have a TTL, so a
		// visible expiry would re-reveal which turfs were assigned by hand.
		expect(
			turfs.filter((t) => t.status === 'checked-out').every((t) => t.expiresInHours === null),
		).toBe(true);
	});
});

describe('geometry pipeline', () => {
	it('builds a drawable hull for every ordinary turf', () => {
		const turfs = demoTurfs(71, { isAdmin: false });
		expect(turfs.every((t) => t.hull.length >= 3)).toBe(true);
	});

	it('puts each turf centroid inside its own bounds', () => {
		for (const t of demoTurfs(72, { isAdmin: false })) {
			expect(t.centre.lat).toBeGreaterThanOrEqual(t.bounds.minLat);
			expect(t.centre.lat).toBeLessThanOrEqual(t.bounds.maxLat);
			expect(t.centre.lng).toBeGreaterThanOrEqual(t.bounds.minLng);
			expect(t.centre.lng).toBeLessThanOrEqual(t.bounds.maxLng);
		}
	});

	it('is deterministic across calls', () => {
		expect(JSON.stringify(demoTurfs(71, { isAdmin: false }))).toBe(
			JSON.stringify(demoTurfs(71, { isAdmin: false })),
		);
	});
});

describe('stress chapter — the load case that decides the rendering strategy', () => {
	const turfs = demoTurfs(STRESS_CHAPTER_ID, { isAdmin: false });

	it('generates a thousand turfs', () => {
		expect(turfs.length).toBe(1000);
	});

	it('spreads them across a county-sized area', () => {
		const lngs = turfs.map((t) => t.centre.lng);
		const spread = Math.max(...lngs) - Math.min(...lngs);
		expect(spread).toBeGreaterThan(1); // > ~50 miles east-west
	});

	// Guards coordinate rounding. Full float precision costs ~9 characters per
	// number and a hull carries ~11 points, so dropping `round()` from
	// buildTurf silently adds ~280 KB here. A budget, not a description: if
	// this fails, fix the payload, don't raise the number.
	it('keeps each turf under 850 bytes on the wire', () => {
		const bytesPerTurf = JSON.stringify(turfs).length / turfs.length;
		expect(bytesPerTurf).toBeLessThan(850);
	});

	// THE FINDING, and it is not the one I expected.
	//
	// A thousand turfs serialise to ~800 KB even with rounded coordinates —
	// far too much to push at a volunteer on cell data at a canvass launch.
	// Dropping hulls entirely only gets to ~390 KB, so hulls are about half the
	// weight and the other half is per-row metadata and JSON key names.
	//
	// That rules out the tempting fix. Paging hulls alone is NOT enough; a
	// chapter this size has to page whole rows by viewport (or cluster them
	// server-side) before it is fit for a phone. Written as a test so the ratio
	// is re-measured rather than remembered.
	it('shows hulls are only half the weight, so hull-paging alone will not fix it', () => {
		const full = JSON.stringify(turfs).length / 1024;
		const withoutHulls =
			JSON.stringify(turfs.map((t) => ({ ...t, hull: undefined }))).length / 1024;

		expect(full).toBeGreaterThan(600); // the problem is real
		expect(withoutHulls).toBeGreaterThan(300); // and survives dropping hulls
		expect(withoutHulls / full).toBeGreaterThan(0.4); // hulls ≈ half, not most
	});

	it('keeps hulls simple enough to render as SVG polygons', () => {
		const vertices = turfs.reduce((n, t) => n + t.hull.length, 0);
		// Average hull complexity drives per-frame projection cost during a drag.
		expect(vertices / turfs.length).toBeLessThan(15);
	});

	it('builds in well under a second', () => {
		const start = performance.now();
		demoTurfs(STRESS_CHAPTER_ID, { isAdmin: false });
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
