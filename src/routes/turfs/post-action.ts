// Posting to one of /turfs' form actions from a component: the mentor
// screens (specs/015-mentor-walks), which take callbacks that post here and
// then reload the page data so what is shown always comes from the server,
// and the map's address search, which only wants the answer.

import { deserialize } from '$app/forms';
import { invalidateAll } from '$app/navigation';

export const SOMETHING_WRONG = 'Something went wrong. Please try again.';

export type Posted =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; data: Record<string, unknown>; message: string };

interface PostOptions {
	/** Reload the page data on success. */
	reload?: boolean;
	/** The key a failure's message is under: each area of the page has its
	 *  own (`mentorError`, `findError`). */
	errorKey?: string;
	/** Abandons the request. Its answer is then SOMETHING_WRONG, which a
	 *  caller that aborted has stopped listening for. */
	signal?: AbortSignal;
}

/** Post `fields` to `?/action`, keeping the page's query so a reload lands
 *  back on the same chapter. Never throws. */
export async function postPageAction(
	action: string,
	fields: Record<string, string | string[]>,
	pageQuery: string,
	{ reload = true, errorKey = 'mentorError', signal }: PostOptions = {},
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
			signal,
		});
		const result = deserialize(await res.text());
		if (result.type === 'success') {
			if (reload) await invalidateAll();
			return { ok: true, data: result.data ?? {} };
		}
		if (result.type === 'failure') {
			const data = result.data ?? {};
			const message = typeof data[errorKey] === 'string' ? data[errorKey] : SOMETHING_WRONG;
			return { ok: false, data, message };
		}
	} catch {
		// Falls through to the generic message.
	}
	return { ok: false, data: {}, message: SOMETHING_WRONG };
}
