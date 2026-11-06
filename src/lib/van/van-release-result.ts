// The line /turfs/organizer shows after "Release all MiniVAN-held turf": what
// it freed, and why the rest of what it counted was left. Pure, so the server's
// reasons and the words for them are tested together.

/** Why a counted turf was not released, as the release store names it. */
export type VanSkipReason = 'not-found' | 'changed' | 'claimed' | 'sheet' | 'not-held';

export interface VanReleaseOutcome {
	released: number;
	skipped: Partial<Record<VanSkipReason, number>>;
}

const turfs = (n: number) => `${n} turf${n === 1 ? '' : 's'}`;

/** Still held, and by what: in the order a reader would act on them. */
const HELD: ReadonlyArray<[VanSkipReason, string]> = [
	['claimed', 'claimed here'],
	['sheet', 'on the Packet Tracker'],
	['changed', 'loaded in MiniVAN again'],
];

export function vanReleaseLabel({ released, skipped }: VanReleaseOutcome): string {
	const parts = [`Released ${turfs(released)} back to volunteers.`];
	const held = HELD.flatMap(([reason, words]) => {
		const n = skipped[reason] ?? 0;
		return n > 0 ? [`${n} ${words}`] : [];
	});
	if (held.length > 0) parts.push(`Left held since the count: ${held.join(', ')}.`);
	// Gone from the release rather than kept by it: freed already, retired,
	// past the hand-out limit, or no longer in what the release reaches.
	const gone = (skipped['not-held'] ?? 0) + (skipped['not-found'] ?? 0);
	if (gone > 0) {
		parts.push(
			`${turfs(gone)} no longer needed releasing (freed already, retired, or past the hand-out limit).`,
		);
	}
	return parts.join(' ');
}
