import { describe, it, expect } from 'vitest';
import { vanReleaseLabel } from './van-release-result.js';

describe('vanReleaseLabel', () => {
	it('says only what was freed when nothing was left', () => {
		expect(vanReleaseLabel({ released: 1, skipped: {} })).toBe(
			'Released 1 turf back to volunteers.',
		);
	});

	it('names what holds each turf left held', () => {
		expect(vanReleaseLabel({ released: 4, skipped: { changed: 1, claimed: 2, sheet: 1 } })).toBe(
			'Released 4 turfs back to volunteers. Left held since the count: 2 claimed here, ' +
				'1 on the Packet Tracker, 1 loaded in MiniVAN again.',
		);
	});

	it('does not call turf freed meanwhile held', () => {
		expect(vanReleaseLabel({ released: 0, skipped: { 'not-held': 2, 'not-found': 1 } })).toBe(
			'Released 0 turfs back to volunteers. 3 turfs no longer needed releasing ' +
				'(freed already, retired, or past the hand-out limit).',
		);
	});
});
