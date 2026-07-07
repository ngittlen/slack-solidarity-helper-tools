import { describe, it, expect } from 'vitest';
import { bucketChapterMoves } from './chapter-reconcile.js';
import type { UserEntry } from './autocomplete-sources.js';

function slackUser(id: string, name: string, email: string): UserEntry {
	return { id, name, realName: name, email };
}

const ENTRIES = [
	{ chapterId: 1, channelId: 'C_LAPEER', name: 'Lapeer' },
	{ chapterId: 1, channelId: 'C_SHARED', name: 'Lapeer' },
	{ chapterId: 2, channelId: 'C_SHARED', name: 'Macomb' },
];

describe('bucketChapterMoves', () => {
	it('invites a matched member into every mapped channel they are missing from', () => {
		const plan = bucketChapterMoves(
			[slackUser('U1', 'Ana', 'ana@x.org')],
			[{ id: 10, email: 'ana@x.org', chapter_id: null, chapter_ids: [1] }],
			ENTRIES,
			new Map([
				['C_LAPEER', new Set<string>()],
				['C_SHARED', new Set<string>()],
			]),
		);

		expect(plan.channels).toHaveLength(2);
		const byChannel = new Map(plan.channels.map((c) => [c.channelId, c.toInvite]));
		expect(byChannel.get('C_LAPEER')).toEqual([
			{ slackUserId: 'U1', email: 'ana@x.org', name: 'Ana', chapterNames: ['Lapeer'] },
		]);
		expect(byChannel.get('C_SHARED')).toEqual([
			{ slackUserId: 'U1', email: 'ana@x.org', name: 'Ana', chapterNames: ['Lapeer'] },
		]);
		expect(plan.alreadyInPlaceCount).toBe(0);
	});

	it('skips channels the person is already in; fully-covered people count as in place', () => {
		const plan = bucketChapterMoves(
			[slackUser('U1', 'Ana', 'ana@x.org'), slackUser('U2', 'Bo', 'bo@x.org')],
			[
				{ id: 10, email: 'ana@x.org', chapter_id: null, chapter_ids: [1] },
				{ id: 11, email: 'bo@x.org', chapter_id: null, chapter_ids: [2] },
			],
			ENTRIES,
			new Map([
				['C_LAPEER', new Set(['U1'])],
				['C_SHARED', new Set(['U2'])],
			]),
		);

		// Ana still needs C_SHARED; Bo is fully covered.
		expect(plan.channels).toHaveLength(1);
		expect(plan.channels[0]!.channelId).toBe('C_SHARED');
		expect(plan.channels[0]!.toInvite.map((p) => p.slackUserId)).toEqual(['U1']);
		expect(plan.alreadyInPlaceCount).toBe(1);
	});

	it('merges chapter names when two of a person’s chapters map to the same channel', () => {
		const plan = bucketChapterMoves(
			[slackUser('U1', 'Ana', 'ana@x.org')],
			[{ id: 10, email: 'ana@x.org', chapter_id: null, chapter_ids: [1, 2] }],
			ENTRIES,
			new Map([
				['C_LAPEER', new Set(['U1'])],
				['C_SHARED', new Set<string>()],
			]),
		);

		expect(plan.channels).toHaveLength(1);
		expect(plan.channels[0]!.toInvite[0]!.chapterNames).toEqual(['Lapeer', 'Macomb']);
	});

	it('falls back to chapter_id when chapter_ids is empty, like the team_join handler', () => {
		const plan = bucketChapterMoves(
			[slackUser('U1', 'Ana', 'ana@x.org')],
			[{ id: 10, email: 'ana@x.org', chapter_id: 2, chapter_ids: [] }],
			ENTRIES,
			new Map([['C_SHARED', new Set<string>()]]),
		);
		expect(plan.channels[0]!.channelId).toBe('C_SHARED');
	});

	it('counts unmatchable and unmapped people instead of inviting them', () => {
		const plan = bucketChapterMoves(
			[slackUser('U1', 'Ana', 'ana@x.org')],
			[
				// chapter has no mapping
				{ id: 10, email: 'x@x.org', chapter_id: null, chapter_ids: [99] },
				// no email on the Solidarity record
				{ id: 11, email: null, chapter_id: null, chapter_ids: [1] },
				// email not in the Slack workspace
				{ id: 12, email: 'ghost@x.org', chapter_id: null, chapter_ids: [1] },
				// no chapters at all → ignored entirely
				{ id: 13, email: 'ana@x.org', chapter_id: null, chapter_ids: [] },
			],
			ENTRIES,
			new Map([
				['C_LAPEER', new Set<string>()],
				['C_SHARED', new Set<string>()],
			]),
		);

		expect(plan.channels).toHaveLength(0);
		expect(plan.unmappedChaptersCount).toBe(1);
		expect(plan.notInSlackCount).toBe(2);
		expect(plan.alreadyInPlaceCount).toBe(0);
	});

	it('matches emails case-insensitively and dedupes duplicate Solidarity accounts', () => {
		const plan = bucketChapterMoves(
			[slackUser('U1', 'Ana', 'Ana@X.org')],
			[
				{ id: 10, email: 'ana@x.org', chapter_id: null, chapter_ids: [1] },
				{ id: 11, email: 'ANA@x.org', chapter_id: null, chapter_ids: [2] },
			],
			ENTRIES,
			new Map([
				['C_LAPEER', new Set<string>()],
				['C_SHARED', new Set<string>()],
			]),
		);

		// Only the first account counts; U1 appears once per channel.
		const shared = plan.channels.find((c) => c.channelId === 'C_SHARED');
		expect(shared!.toInvite).toHaveLength(1);
		expect(shared!.toInvite[0]!.chapterNames).toEqual(['Lapeer']);
	});

	it('sorts each channel’s invitees by display name', () => {
		const plan = bucketChapterMoves(
			[slackUser('U1', 'Zoe', 'z@x.org'), slackUser('U2', 'Al', 'a@x.org')],
			[
				{ id: 10, email: 'z@x.org', chapter_id: null, chapter_ids: [1] },
				{ id: 11, email: 'a@x.org', chapter_id: null, chapter_ids: [1] },
			],
			ENTRIES,
			new Map([
				['C_LAPEER', new Set<string>()],
				['C_SHARED', new Set<string>()],
			]),
		);
		expect(plan.channels[0]!.toInvite.map((p) => p.name)).toEqual(['Al', 'Zoe']);
	});
});
