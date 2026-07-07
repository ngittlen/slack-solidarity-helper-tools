// Pure helpers for the header countdown: remaining-time math for the display
// and datetime-local ↔ ISO conversion for the settings editor. Kept free of
// Svelte/runtime imports so they are unit-testable like the other extracted
// helpers in this directory.

export interface CountdownParts {
	days: number;
	hours: number;
	minutes: number;
	seconds: number;
	expired: boolean;
}

/** Whole days/hours/minutes/seconds remaining until `endAtMs`, floored (the
 *  final partial second displays as 0s). Clamps to zeros once the end has
 *  passed. */
export function countdownParts(endAtMs: number, nowMs: number): CountdownParts {
	const remainingSeconds = Math.floor((endAtMs - nowMs) / 1000);
	if (remainingSeconds <= 0) {
		return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: endAtMs - nowMs <= 0 };
	}
	return {
		days: Math.floor(remainingSeconds / 86_400),
		hours: Math.floor(remainingSeconds / 3600) % 24,
		minutes: Math.floor(remainingSeconds / 60) % 60,
		seconds: remainingSeconds % 60,
		expired: false,
	};
}

/** ISO datetime → `<input type="datetime-local">` value (local time, minute
 *  precision). '' for unset or unparseable input. */
export function isoToLocalInput(iso: string): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `<input type="datetime-local">` value (parsed as local time, per spec) →
 *  ISO datetime. '' for an empty or unparseable input — the API's "clear". */
export function localInputToIso(value: string): string {
	if (!value) return '';
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return '';
	return d.toISOString();
}
