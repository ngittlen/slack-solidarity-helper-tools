// Putting a value someone else chose into a log line.
//
// An OAuth provider's `?error=` comes back on a URL anyone can type, so it is
// attacker-supplied text. Written raw, a newline in it starts a fake log line
// of the attacker's choosing. Quoted, it is one visibly delimited value, with
// any newline shown as `\n`; capped, so it cannot fill the log either.

const MAX_LOGGED = 200;

export function logText(raw: string | null | undefined): string {
	if (raw === null || raw === undefined) return 'null';
	return JSON.stringify(raw.length > MAX_LOGGED ? `${raw.slice(0, MAX_LOGGED)}…` : raw);
}
