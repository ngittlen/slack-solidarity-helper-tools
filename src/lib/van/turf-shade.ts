// How strongly a turf is painted on the map.
//
// The map already answers "can I take this?" with hue: blue is available,
// green is yours, muted brown is taken. This adds the second question a
// volunteer actually asks while choosing — "how much work is left in it?" —
// by ramping the fill of available turf with the doors it still has.
//
// Three decisions worth keeping:
//
// 1. **Banded, not continuous.** Nobody can tell 40 doors from 45 by colour,
//    and a continuous ramp cannot be put in a legend. Four bands can, and they
//    line up with how turf actually wears down: untouched, mostly fresh, part
//    walked, nearly done.
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
