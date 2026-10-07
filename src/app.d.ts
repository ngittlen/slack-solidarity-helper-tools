// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			session: {
				slackUserId: string;
				slackUserName: string;
				isAdmin: boolean;
				/** Absent on sessions that predate moderators — read as false. */
				isModerator?: boolean;
				/** 'google' or 'apple' for an outside sign-in; absent means Slack.
				 *  See $lib/server/identity.ts for what `slackUserId` holds then. */
				authProvider?: 'google' | 'apple';
				/** An outside volunteer who has not given a name yet — see
				 *  SessionData in $lib/server/db.ts. */
				needsName?: true;
			} | null;
		}
	}
}

export {};
