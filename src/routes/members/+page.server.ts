import { redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { memberAccountLinks } from '$lib/server/schema.js';
import { getSlackUsers } from '$lib/server/autocomplete-sources.js';
import {
	findUserByEmailStrict,
	getRecentUserActions,
	getRecentEventRsvps,
} from '$lib/server/solidarity.js';
import { listNotes } from '$lib/server/member-notes.js';
import {
	resolveMember,
	type MemberDetail,
	type MemberLookupDeps,
} from '$lib/server/member-lookup.js';

export interface MembersPageData {
	pageTitle: 'Member lookup';
	selectedSlackUserId: string | null;
	/** Streamed: the shell and the search box render immediately while the
	 *  Solidarity round trips resolve. */
	member: Promise<MemberDetail | null> | null;
}

const deps: MemberLookupDeps = {
	async findSlackUser(slackUserId) {
		const { items } = await getSlackUsers(slack);
		const found = items.find((u) => u.id === slackUserId);
		return found
			? { id: found.id, name: found.name, realName: found.realName, email: found.email }
			: null;
	},

	async findLink(slackUserId) {
		const [row] = await db
			.select()
			.from(memberAccountLinks)
			.where(eq(memberAccountLinks.slackUserId, slackUserId))
			.limit(1);
		return row
			? {
					solidarityUserId: row.solidarityUserId,
					linkedByName: row.linkedByName,
					linkedAt: row.linkedAt,
				}
			: null;
	},

	// Strict on purpose: a swallowed 500 here would show "can't find this
	// member's Solidarity account" and invite an admin to hand-link someone who
	// already matches perfectly well.
	findByEmail: (email) => findUserByEmailStrict(SOLIDARITY_API_TOKEN, email),

	async fetchActions(solidarityUserId) {
		const feed = await getRecentUserActions(SOLIDARITY_API_TOKEN, solidarityUserId);
		return { ok: true, ...feed };
	},

	async fetchRsvps(solidarityUserId) {
		const feed = await getRecentEventRsvps(SOLIDARITY_API_TOKEN, solidarityUserId);
		return { ok: true, ...feed };
	},

	listNotes: (slackUserId) => listNotes(db, slackUserId),
};

export const load: PageServerLoad = ({ locals, url }) => {
	// Re-checked here as well as in the layout: layout and page loads run
	// concurrently, so the layout's redirect cannot be relied on to gate this.
	if (!locals.session?.isAdmin) {
		redirect(302, '/');
	}

	const selectedSlackUserId = url.searchParams.get('user');

	return {
		pageTitle: 'Member lookup',
		selectedSlackUserId,
		// Returned unawaited so SvelteKit streams it.
		member: selectedSlackUserId ? resolveMember(deps, selectedSlackUserId) : null,
	} satisfies MembersPageData;
};
