import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { bucketCoalitionMembers, computeCoalitionDiff } from './coalition-reconcile.js';

const mockGetSlackUsers = vi.hoisted(() => vi.fn());
const mockFindUserByEmailStrict = vi.hoisted(() => vi.fn());
const mockGetUsersInList = vi.hoisted(() => vi.fn());

vi.mock('./autocomplete-sources.js', () => ({ getSlackUsers: mockGetSlackUsers }));
vi.mock('./solidarity.js', () => ({
	findUserByEmailStrict: mockFindUserByEmailStrict,
	getUsersInList: mockGetUsersInList,
}));

function slackUser(id: string, name: string, email: string) {
	return { id, name, realName: name, email };
}

describe('bucketCoalitionMembers', () => {
	// Cast: channel members in Slack, list members in Solidarity.
	//   alice — in channel, in list           → consistent
	//   bob   — in channel, not in list       → unmatched (lookup decides)
	//   carol — in list, in Slack, not in channel → toInvite
	//   dana  — in list, not in Slack at all  → notInSlack
	//   ed    — in channel, no profile email  → noEmail
	const slackUsers = [
		slackUser('U_ALICE', 'alice', 'alice@example.com'),
		slackUser('U_BOB', 'bob', 'Bob@Example.com'), // case-insensitive matching
		slackUser('U_CAROL', 'carol', 'carol@example.com'),
		slackUser('U_ED', 'ed', ''),
	];
	const listUsers = [
		{ id: 1, email: 'alice@example.com', first_name: 'Alice', last_name: 'A' },
		{ id: 3, email: 'CAROL@example.com', first_name: 'Carol', last_name: 'C' },
		{ id: 4, email: 'dana@example.com', first_name: 'Dana', last_name: 'D' },
	];
	const channelMemberIds = new Set(['U_ALICE', 'U_BOB', 'U_ED', 'B_BOT']);

	it('buckets each person by channel/list/workspace membership', () => {
		const result = bucketCoalitionMembers(channelMemberIds, slackUsers, listUsers);

		expect(result.consistentCount).toBe(1); // alice
		expect(result.noEmailCount).toBe(1); // ed
		expect(result.unmatchedChannelMembers).toEqual([
			{ email: 'bob@example.com', name: 'bob', slackUserId: 'U_BOB' },
		]);
		expect(result.toInvite).toEqual([
			{
				email: 'carol@example.com',
				name: 'carol',
				slackUserId: 'U_CAROL',
				solidarityUserId: 3,
			},
		]);
		expect(result.notInSlack).toEqual([
			{ email: 'dana@example.com', name: 'Dana D', slackUserId: null, solidarityUserId: 4 },
		]);
	});

	it('ignores channel member ids with no human slack-user entry (bots/apps)', () => {
		const result = bucketCoalitionMembers(new Set(['B_BOT']), slackUsers, listUsers);
		expect(result.consistentCount).toBe(0);
		expect(result.unmatchedChannelMembers).toEqual([]);
		expect(result.noEmailCount).toBe(0);
	});

	it('handles empty inputs', () => {
		const result = bucketCoalitionMembers(new Set(), [], []);
		expect(result).toEqual({
			unmatchedChannelMembers: [],
			toInvite: [],
			notInSlack: [],
			consistentCount: 0,
			noEmailCount: 0,
		});
	});
});

describe('computeCoalitionDiff', () => {
	const membersMock = vi.fn();
	const slack = {
		conversations: { members: membersMock },
	} as unknown as WebClient;

	beforeEach(() => {
		vi.clearAllMocks();
		membersMock.mockResolvedValue({ members: ['U_ALICE', 'U_BOB', 'U_FRAN'] });
		mockGetSlackUsers.mockResolvedValue({
			items: [
				slackUser('U_ALICE', 'alice', 'alice@example.com'),
				slackUser('U_BOB', 'bob', 'bob@example.com'),
				slackUser('U_FRAN', 'fran', 'fran@example.com'),
			],
			stale: false,
			fetchedAt: 1,
		});
		mockGetUsersInList.mockResolvedValue([
			{ id: 1, email: 'alice@example.com', first_name: 'Alice', last_name: 'A' },
		]);
	});

	it('splits unmatched channel members into toMark/noAccount via the strict lookup', async () => {
		mockFindUserByEmailStrict.mockImplementation(async (_tok: string, email: string) =>
			email === 'bob@example.com' ? { id: 2 } : null,
		);

		const diff = await computeCoalitionDiff({
			slack,
			token: 'tok',
			channelId: 'C1',
			userListId: 42,
		});

		expect(mockGetUsersInList).toHaveBeenCalledWith('tok', 42);
		expect(diff.consistentCount).toBe(1); // alice
		expect(diff.toMark).toEqual([
			{ email: 'bob@example.com', name: 'bob', slackUserId: 'U_BOB', solidarityUserId: 2 },
		]);
		expect(diff.noAccount).toEqual([
			{ email: 'fran@example.com', name: 'fran', slackUserId: 'U_FRAN', solidarityUserId: null },
		]);
		expect(diff.toInvite).toEqual([]);
		expect(diff.notInSlack).toEqual([]);
	});

	it('paginates conversations.members across cursors', async () => {
		membersMock
			.mockResolvedValueOnce({
				members: ['U_ALICE'],
				response_metadata: { next_cursor: 'page2' },
			})
			.mockResolvedValueOnce({ members: ['U_BOB'] });
		mockFindUserByEmailStrict.mockResolvedValue({ id: 2 });

		const diff = await computeCoalitionDiff({
			slack,
			token: 'tok',
			channelId: 'C1',
			userListId: 42,
		});

		expect(membersMock).toHaveBeenCalledTimes(2);
		expect(membersMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: 'page2' }),
		);
		// Both pages' members were seen: alice consistent, bob marked.
		expect(diff.consistentCount).toBe(1);
		expect(diff.toMark).toHaveLength(1);
	});

	it('propagates a strict-lookup failure instead of misclassifying', async () => {
		mockFindUserByEmailStrict.mockRejectedValue(new Error('solidarity 500'));

		await expect(
			computeCoalitionDiff({ slack, token: 'tok', channelId: 'C1', userListId: 42 }),
		).rejects.toThrow(/solidarity 500/);
	});
});
