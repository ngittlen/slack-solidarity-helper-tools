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
				/** 'google' for a Google sign-in; absent means Slack. See
				 *  $lib/server/identity.ts for what `slackUserId` holds then. */
				authProvider?: 'google';
			} | null;
		}
	}
}

export {};
