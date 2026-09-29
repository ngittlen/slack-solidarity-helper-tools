// How strongly a turf is painted on the map.
//
// The map already answers "can I take this?" with hue: blue is available,
// green is yours, muted brown is taken. This adds the second question a
// volunteer actually asks while choosing — "how much work is left in it?" —
// by ramping the fill of available turf with the doors it still has.
//
// Three decisions worth keeping:
//
// 1. **Continuous colour, banded words.** The fill follows `doorRamp`, a
//    smooth 0–1 scale, so neighbouring counts get neighbouring colours — four
//    hard bands put a visible step between 49 and 50 doors that meant nothing
//    on the ground. The bands survive for what is SAID (screen readers, via
//    `shadeLabel`), where "nearly finished" beats a number between 0 and 1.
//
// 2. **Absolute thresholds, not relative to what is on screen.** Normalising
//    against the current viewport would repaint every turf as you pan, so the
//    same turf would be dark in one view and pale in the next. The colour has
//    to mean the same thing everywhere or it means nothing.
//
// 3. **Zero doors is a different KIND of thing, not a paler one.** A turf with
//    nothing left is finished, and `canClaim` already refuses it. If it were
//    simply the bottom of the ramp it would be a shade away from a turf with
//    one door still on it — which is the distinction that matters most here,
//    because one is worth walking to and the other is a wasted trip. It gets a
//    dashed outline and the taken-turf grey instead, so it differs in outline
//    style as well as colour and stays readable without colour vision.

import type { VolunteerStatus } from './turf-status.js';

export type TurfShade =
	/** Yours. Hue carries this; the ramp does not apply. */
	| 'yours'
	/** Held by someone else, or assigned in VAN. Hue carries this too. */
	| 'taken'
	/** Available, but every door has been knocked. Not claimable. */
	| 'cleared'
	/** Available, 1–9 doors. */
	| 'low'
	/** Available, 10–29 doors. */
	| 'medium'
	/** Available, 30–49 doors. */
	| 'high'
	/** Available, 50+ doors. */
	| 'full';

export interface DoorBand {
	shade: Extract<TurfShade, 'low' | 'medium' | 'high' | 'full'>;
	/** Inclusive lower bound on doors remaining. */
	min: number;
	label: string;
}

/**
 * The bands, densest first.
 *
 * Tuned to how VAN turf is actually cut — commonly 50–100 doors — so a fresh
 * turf lands in `full`, and the lower bands spread across the range a turf
 * passes through as it gets walked rather than bunching at the bottom.
 */
export const DOOR_BANDS: readonly DoorBand[] = [
	{ shade: 'full', min: 50, label: '50+' },
	{ shade: 'high', min: 30, label: '30–49' },
	{ shade: 'medium', min: 10, label: '10–29' },
	{ shade: 'low', min: 1, label: '1–9' },
];

/**
 * How to paint one turf.
 *
 * Status wins over door count: a turf someone is walking right now reads as
 * taken whether it has two doors left or two hundred, because the door count
 * is not something the viewer can act on.
 */
export function turfShade(status: VolunteerStatus, doorsRemaining: number): TurfShade {
	if (status === 'held-by-you') return 'yours';
	if (status === 'checked-out') return 'taken';
	// Negative should be impossible, but a bad row must not fall through the
	// band table and come back undefined.
	if (!Number.isFinite(doorsRemaining) || doorsRemaining <= 0) return 'cleared';
	return DOOR_BANDS.find((band) => doorsRemaining >= band.min)?.shade ?? 'low';
}

/** Doors at which the colour scale tops out. Turf is commonly cut at 50–100
 *  doors, so capping here keeps fresh turfs distinguishable from each other
 *  rather than all painting as the same solid colour. */
export const RAMP_FULL_DOORS = 80;

/**
 * Where a door count sits on the colour scale: 0 at one door, 1 at
 * RAMP_FULL_DOORS or more, linear in between. The map, the legend and the
 * list's door tiles all mix their hue and strength from this, so a turf looks
 * the same everywhere. Zero doors never reaches it — that is `cleared`.
 */
export function doorRamp(doorsRemaining: number): number {
	if (!Number.isFinite(doorsRemaining) || doorsRemaining <= 1) return 0;
	return Math.min(1, (doorsRemaining - 1) / (RAMP_FULL_DOORS - 1));
}

/** The inline style that carries `doorRamp` to CSS, rounded so the value
 *  is stable across renders and readable in the inspector. */
export function rampStyle(doorsRemaining: number): string {
	return `--turf-t: ${doorRamp(doorsRemaining).toFixed(3)}`;
}

/** Spoken form, for the map's accessible label. The visual ramp is invisible
 *  to a screen reader, so the band has to be said out loud. */
export function shadeLabel(shade: TurfShade): string {
	switch (shade) {
		case 'yours':
			return 'checked out by you';
		case 'taken':
			return 'checked out';
		case 'cleared':
			return 'no doors left';
		case 'low':
			return 'nearly finished';
		case 'medium':
			return 'part walked';
		case 'high':
			return 'mostly unwalked';
		case 'full':
			return 'untouched';
	}
}
