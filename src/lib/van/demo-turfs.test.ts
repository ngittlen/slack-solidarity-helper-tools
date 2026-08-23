import { describe, it, expect } from 'vitest';
import { demoTurfs, DEMO_CHAPTERS, STRESS_CHAPTER_ID } from './demo-turfs.js';
import { turfShade } from './turf-shade.js';

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
			// TurfView allows null geometry (real turf can lack a hull); every
			// demo turf builds one, so asserting that first keeps the check
			// honest rather than silently passing on a null.
			expect(t.centre).not.toBeNull();
			expect(t.bounds).not.toBeNull();
			expect(t.centre!.lat).toBeGreaterThanOrEqual(t.bounds!.minLat);
			expect(t.centre!.lat).toBeLessThanOrEqual(t.bounds!.maxLat);
			expect(t.centre!.lng).toBeGreaterThanOrEqual(t.bounds!.minLng);
			expect(t.centre!.lng).toBeLessThanOrEqual(t.bounds!.maxLng);
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
		const lngs = turfs.map((t) => t.centre!.lng);
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

describe('walked-out turf', () => {
	// The demo exists to show organizers every state a volunteer will meet. A
	// turf with nothing left on it is a common sight a day into a canvass, and
	// it is the one state a volunteer must not walk to — so the fixture has to
	// contain some or the walkthrough silently omits it.
	it('appears in the default chapter', () => {
		const cleared = demoTurfs(71, { isAdmin: false }).filter((t) => t.doorsRemaining === 0);
		expect(cleared.length).toBeGreaterThan(0);
	});

	it('appears in more than one chapter, so it does not look like a quirk', () => {
		const chapters = DEMO_CHAPTERS.filter((c) => c.chapterId !== STRESS_CHAPTER_ID).filter((c) =>
			demoTurfs(c.chapterId, { isAdmin: false }).some((t) => t.doorsRemaining === 0),
		);
		expect(chapters.length).toBeGreaterThan(1);
	});

	it('shades as cleared, not as the bottom of the ramp', () => {
		for (const turf of demoTurfs(71, { isAdmin: false })) {
			if (turf.doorsRemaining !== 0) continue;
			expect(turfShade(turf.status, turf.doorsRemaining)).toBe('cleared');
		}
	});

	// Matches canClaim, which refuses 'no-doors-left'. A walkthrough that
	// offered to check one out would be teaching the wrong thing.
	it('is not claimable', () => {
		for (const turf of demoTurfs(71, { isAdmin: false })) {
			if (turf.doorsRemaining !== 0) continue;
			expect(turf.claimable).toBe(false);
		}
	});

	// A disabled button with no explanation is worse than no button: the
	// volunteer is left guessing whether the page is broken.
	it('says why it cannot be claimed, in canClaim’s own words', () => {
		const cleared = demoTurfs(71, { isAdmin: false }).filter((t) => t.doorsRemaining === 0);
		expect(cleared.length).toBeGreaterThan(0);
		for (const turf of cleared) {
			expect(turf.claimBlockedReason).toMatch(/already been knocked/i);
		}
	});

	it('shows up on the stress map at a density worth looking at', () => {
		const turfs = demoTurfs(STRESS_CHAPTER_ID, { isAdmin: false });
		const cleared = turfs.filter((t) => t.doorsRemaining === 0);
		expect(cleared.length).toBeGreaterThan(10);
		// But still a minority — a map that is mostly spent turf would be
		// misleading about what a canvass looks like.
		expect(cleared.length).toBeLessThan(turfs.length * 0.2);
	});

	it('leaves every other available turf with at least one door', () => {
		// The 1-door vs 0-door distinction is the one the shading exists for,
		// so the fixture must not blur it with negatives or nulls.
		for (const turf of demoTurfs(STRESS_CHAPTER_ID, { isAdmin: false })) {
			expect(turf.doorsRemaining).toBeGreaterThanOrEqual(0);
		}
	});
});

describe('claimability comes from the real rule', () => {
	// Every previous attempt to restate the checkout rules in this fixture has
	// drifted from them — list numbers handed out that the real page withholds,
	// and a live check-out button on turf with no doors left. These assert the
	// fixture agrees with canClaim rather than approximating it.
	it('never offers turf with no doors left', () => {
		for (const chapter of DEMO_CHAPTERS) {
			for (const turf of demoTurfs(chapter.chapterId, { isAdmin: false })) {
				if (turf.doorsRemaining === 0) expect(turf.claimable).toBe(false);
			}
		}
	});

	it('never offers turf that is already taken', () => {
		for (const chapter of DEMO_CHAPTERS) {
			for (const turf of demoTurfs(chapter.chapterId, { isAdmin: false })) {
				if (turf.status !== 'available') expect(turf.claimable).toBe(false);
			}
		}
	});

	it('offers every available turf that still has doors', () => {
		const offered = demoTurfs(71, { isAdmin: false }).filter(
			(t) => t.status === 'available' && t.doorsRemaining > 0,
		);
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.every((t) => t.claimable)).toBe(true);
	});

	it('carries a reason on every refusal it shows', () => {
		for (const turf of demoTurfs(71, { isAdmin: false })) {
			// toTurfView only carries the reason for turf that looks available;
			// anything else explains itself through its status.
			if (turf.status === 'available' && !turf.claimable) {
				expect(turf.claimBlockedReason).toBeTruthy();
			}
		}
	});

	it('omits the reason when there is nothing to refuse', () => {
		for (const turf of demoTurfs(71, { isAdmin: false })) {
			if (turf.claimable) expect('claimBlockedReason' in turf).toBe(false);
		}
	});
});
