// English ordinals for the warning DM ("This is your third warning...").
//
// Kept generic and dependency-free — it has nothing to do with Slack or
// Solidarity — so it sits beside welcome-dm.ts rather than inside warning-dm.ts,
// which stays about templating.

const WORDS = [
	'first',
	'second',
	'third',
	'fourth',
	'fifth',
	'sixth',
	'seventh',
	'eighth',
	'ninth',
	'tenth',
] as const;

/**
 * `1`–`10` render as words (`'first'` … `'tenth'`); above that as a numeric
 * ordinal (`'11th'`, `'21st'`, `'103rd'`).
 *
 * Never throws and never returns something unreadable: this string is
 * interpolated straight into a DM sent to a member, so a bad input has to
 * degrade to a sentence that still reads correctly rather than surfacing
 * `NaN` or blowing up the send. Anything non-finite, non-integer, or below 1
 * falls back to `'first'`.
 */
export function ordinal(n: number): string {
	if (!Number.isFinite(n)) return WORDS[0];
	const i = Math.floor(n);
	if (i < 1) return WORDS[0];
	if (i <= WORDS.length) return WORDS[i - 1]!;
	return `${i}${numericSuffix(i)}`;
}

/**
 * The `st`/`nd`/`rd`/`th` suffix. 11, 12 and 13 are the trap: they end in 1, 2
 * and 3 but take `th`, and so does every number ending in those two digits
 * (111th, 212th, 1013th). Check the last two digits before the last one.
 */
function numericSuffix(i: number): string {
	const lastTwo = i % 100;
	if (lastTwo >= 11 && lastTwo <= 13) return 'th';
	switch (i % 10) {
		case 1:
			return 'st';
		case 2:
			return 'nd';
		case 3:
			return 'rd';
		default:
			return 'th';
	}
}
