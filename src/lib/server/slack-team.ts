// This deployment's Slack workspace id, for the sign-in link.
//
// Slack's authorize URL takes an optional `team`. Without it, someone signing
// in for the first time on a browser that is not already signed in to Slack
// lands on slack.com/workspace-signin and has to type the workspace's name —
// which a new volunteer arriving from the public /turfs page may not know.
// With it, Slack goes straight to this workspace's own sign-in.
//
// The id comes from `auth.test` on the bot token, which belongs to exactly one
// workspace, so there is nothing to configure. Asked once per process and
// cached; a failure is not cached, and it costs nothing but the pre-fill —
// sign-in then works exactly as it did before this existed.

import { slack } from './slack.js';

/** Sign-in waits at most this long for Slack before going ahead without it. */
const LOOKUP_TIMEOUT_MS = 2000;

type AuthTest = () => Promise<{ ok?: boolean; team_id?: string }>;

let cached: string | null = null;

/** The workspace id (`T…`), or null when Slack could not say in time. */
export async function workspaceTeamId(
	authTest: AuthTest = () => slack.auth.test(),
): Promise<string | null> {
	if (cached) return cached;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
		});
		const result = await Promise.race([authTest(), timeout]);
		const id = result?.ok ? result.team_id : undefined;
		if (typeof id === 'string' && /^[TE][A-Z0-9]+$/.test(id)) {
			cached = id;
			return id;
		}
		console.warn(
			result ? '[auth] auth.test returned no workspace id' : '[auth] workspace id lookup timed out',
		);
	} catch (err) {
		console.warn('[auth] workspace id lookup failed:', err instanceof Error ? err.message : err);
	} finally {
		clearTimeout(timer);
	}
	return null;
}

/** For tests: forget the cached id. */
export function resetWorkspaceTeamId(): void {
	cached = null;
}
