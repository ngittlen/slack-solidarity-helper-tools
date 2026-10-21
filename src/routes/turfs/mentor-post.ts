// Posting to one of /turfs' `mentor*` form actions from a component, the way
// MentorPanel and WalkFinder do (specs/015-mentor-walks): the screens take
// callbacks, and each callback posts here, then reloads the page data so what
// is shown always comes from the server.

import { deserialize } from '$app/forms';
import { invalidateAll } from '$app/navigation';

export const SOMETHING_WRONG = 'Something went wrong. Please try again.';

export type Posted =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; data: Record<string, unknown>; message: string };

/** Post `fields` to `?/action`, keeping the page's query so a reload lands
 *  back on the same chapter. On success the page data reloads, unless
 *  `reload` is false. Never throws. */
export async function postMentorAction(
	action: string,
	fields: Record<string, string | string[]>,
	pageQuery: string,
	{ reload = true } = {},
): Promise<Posted> {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
	}
	try {
		const res = await fetch(`?/${action}${pageQuery ? `&${pageQuery}` : ''}`, {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' },
		});
		const result = deserialize(await res.text());
		if (result.type === 'success') {
			if (reload) await invalidateAll();
			return { ok: true, data: result.data ?? {} };
		}
		if (result.type === 'failure') {
			const data = result.data ?? {};
			const message = typeof data.mentorError === 'string' ? data.mentorError : SOMETHING_WRONG;
			return { ok: false, data, message };
		}
	} catch {
		// Falls through to the generic message.
	}
	return { ok: false, data: {}, message: SOMETHING_WRONG };
}
