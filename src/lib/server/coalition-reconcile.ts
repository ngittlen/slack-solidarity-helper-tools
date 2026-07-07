// Coalition reconciliation: diff the members of a coalition's Slack channel
// against the members of its Solidarity user list (the dynamic list mirroring
// the coalition's custom property), matching people by email.
//
// The pure bucketing (`bucketCoalitionMembers`) is separated from the
// orchestrator (`computeCoalitionDiff`) so the matching rules are unit-testable
// without Slack/Solidarity mocks; the orchestrator owns fetching and the
// per-email account lookups.

import type { WebClient } from '@slack/web-api';
import { getSlackUsers, type UserEntry } from './autocomplete-sources.js';
import {
	findUserByEmailStrict,
	getUsersInList,
	type SolidarityListUser,
} from './solidarity.js';

/** One person in a reconciliation bucket, with whichever ids we resolved. */
export interface ReconcilePerson {
	email: string;
	name: string;
	slackUserId: string | null;
	solidarityUserId: number | null;
}

export interface ReconcileDiff {
	/** In the Slack channel with a Solidarity account, but not in the coalition list → set the property. */
	toMark: ReconcilePerson[];
	/** In the coalition list and in the Slack workspace, but not in the channel → invite. */
	toInvite: ReconcilePerson[];
	/** In the Slack channel but no Solidarity account matches their Slack email. Report-only. */
	noAccount: ReconcilePerson[];
	/** In the coalition list but their email isn't in the Slack workspace at all. Report-only. */
	notInSlack: ReconcilePerson[];
	/** In the channel, in the list — nothing to do. Count only, for the summary line. */
	consistentCount: number;
	/** Channel members whose Slack profile has no email — can't be matched. */
	noEmailCount: number;
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function listUserName(u: SolidarityListUser): string {
	return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

export interface BucketResult {
	/** Channel members not in the list — need a per-email account lookup to split toMark/noAccount. */
	unmatchedChannelMembers: { email: string; name: string; slackUserId: string }[];
	toInvite: ReconcilePerson[];
	notInSlack: ReconcilePerson[];
	consistentCount: number;
	noEmailCount: number;
}

/**
 * Pure matching pass. `channelMemberIds` comes from conversations.members and
 * includes bots/apps — membership is intersected with the human-only
 * `slackUsers` cache, so non-humans (including this bot) are ignored entirely.
 */
export function bucketCoalitionMembers(
	channelMemberIds: ReadonlySet<string>,
	slackUsers: readonly UserEntry[],
	listUsers: readonly SolidarityListUser[],
): BucketResult {
	const listByEmail = new Map<string, SolidarityListUser>();
	for (const u of listUsers) {
		if (u.email) listByEmail.set(normalizeEmail(u.email), u);
	}
	const slackByEmail = new Map<string, UserEntry>();
	for (const u of slackUsers) {
		if (u.email) slackByEmail.set(normalizeEmail(u.email), u);
	}

	const unmatchedChannelMembers: BucketResult['unmatchedChannelMembers'] = [];
	let consistentCount = 0;
	let noEmailCount = 0;
	const channelEmails = new Set<string>();

	for (const user of slackUsers) {
		if (!channelMemberIds.has(user.id)) continue;
		if (!user.email) {
			noEmailCount++;
			continue;
		}
		const email = normalizeEmail(user.email);
		channelEmails.add(email);
		if (listByEmail.has(email)) {
			consistentCount++;
		} else {
			unmatchedChannelMembers.push({ email, name: user.name, slackUserId: user.id });
		}
	}

	const toInvite: ReconcilePerson[] = [];
	const notInSlack: ReconcilePerson[] = [];
	for (const [email, listUser] of listByEmail) {
		if (channelEmails.has(email)) continue;
		const slackUser = slackByEmail.get(email);
		if (slackUser) {
			toInvite.push({
				email,
				name: slackUser.name,
				slackUserId: slackUser.id,
				solidarityUserId: listUser.id,
			});
		} else {
			notInSlack.push({
				email,
				name: listUserName(listUser),
				slackUserId: null,
				solidarityUserId: listUser.id,
			});
		}
	}

	return { unmatchedChannelMembers, toInvite, notInSlack, consistentCount, noEmailCount };
}

/** Bounded-concurrency map — the per-email lookups would be too slow serially
 *  and would hammer the API fully parallel. */
async function mapPool<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]!);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** Every member id of a channel (paginated). Shared with chapter-reconcile. */
export async function fetchChannelMemberIds(
	slack: WebClient,
	channelId: string,
): Promise<Set<string>> {
	const ids = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await slack.conversations.members({ channel: channelId, limit: 1000, cursor });
		for (const id of page.members ?? []) ids.add(id);
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return ids;
}

const LOOKUP_CONCURRENCY = 5;

export async function computeCoalitionDiff(opts: {
	slack: WebClient;
	token: string;
	channelId: string;
	userListId: number;
}): Promise<ReconcileDiff> {
	const [channelMemberIds, slackUsersResult, listUsers] = await Promise.all([
		fetchChannelMemberIds(opts.slack, opts.channelId),
		getSlackUsers(opts.slack),
		getUsersInList(opts.token, opts.userListId),
	]);

	const buckets = bucketCoalitionMembers(channelMemberIds, slackUsersResult.items, listUsers);

	// Channel members not in the list either lack the property (fixable) or
	// lack a Solidarity account entirely (report-only). One strict lookup per
	// person decides which; a lookup failure fails the diff rather than
	// misfiling anyone.
	const toMark: ReconcilePerson[] = [];
	const noAccount: ReconcilePerson[] = [];
	const lookups = await mapPool(buckets.unmatchedChannelMembers, LOOKUP_CONCURRENCY, async (m) => ({
		member: m,
		account: await findUserByEmailStrict(opts.token, m.email),
	}));
	for (const { member, account } of lookups) {
		if (account) {
			toMark.push({
				email: member.email,
				name: member.name,
				slackUserId: member.slackUserId,
				solidarityUserId: account.id,
			});
		} else {
			noAccount.push({
				email: member.email,
				name: member.name,
				slackUserId: member.slackUserId,
				solidarityUserId: null,
			});
		}
	}

	return {
		toMark,
		toInvite: buckets.toInvite,
		noAccount,
		notInSlack: buckets.notInSlack,
		consistentCount: buckets.consistentCount,
		noEmailCount: buckets.noEmailCount,
	};
}
