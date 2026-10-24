// Lets a page open the header's bell (NotificationToggle) on its mentor-walk
// alert settings: /turfs' "Tell me when a mentor plans a walk near me" and
// "Your alerts" links (specs/015-mentor-walks, User Story 7).
//
// Module state, so shared by everything on the page. Only ever written from
// a click in the browser, never while rendering on the server, so one
// person's request can't leave anything here for another's.

export const bell = $state({
	open: false,
	/** What the walk-alert section opens on: the form, or "Stop these
	 *  alerts?" from an alert's link. */
	walkAlerts: null as 'setup' | 'stop' | null,
	/** Opened from the new-person prompt: saving answers it Yes too. */
	fromPrompt: false,
});

/** Open the bell on walk alerts: on the form to set them up, or as they
 *  are, to see or change them. */
export function openWalkAlerts(options: { setup?: boolean; fromPrompt?: boolean } = {}): void {
	bell.walkAlerts = options.setup ? 'setup' : null;
	bell.fromPrompt = options.fromPrompt ?? false;
	bell.open = true;
}
