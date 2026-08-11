import { describe, it, expect, vi } from 'vitest';
import { recordAudit, formatChanges, type SightingChange } from './slack-invite-log.js';
import type { AuditResult, InviteRef } from './slack-invite-audit.js';

const STALE =
	'https://join.slack.com/t/exampleworkspace/shared_invite/zt-3uwkykldf-20xkOyZVYH1VKkVDnWDVLw';

function ref(overrides: Partial<InviteRef> = {}): InviteRef {
	return {
		url: STALE,
		pageId: 10904,
		pageName: 'Women’s Caucus',
		pageUrl: 'https://go.example.org/womens-caucus',
		websiteId: 999,
		location: 'follow-up email',
		...overrides,
	};
}

function auditResult(refs: InviteRef[], status: 'valid' | 'broken' | 'unknown'): AuditResult {
	return {
		pagesScanned: 1442,
		pagesFetchedAsHtml: 73,
		refs,
		distinctUrls: new Set(refs.map((r) => r.url)).size,
		statuses: new Map(refs.map((r) => [r.url, { status, detail: 'detail' }])),
		broken: status === 'broken' ? refs : [],
		unknown: status === 'unknown' ? refs : [],
	};
}

// Chained-builder stubs, following the member-notes.test.ts pattern.
function makeDb(existingRows: Record<string, unknown>[] = []) {
	const limit = vi.fn().mockResolvedValue(existingRows);
	const selectWhere = vi.fn(() => ({ limit }));
	const selectFrom = vi.fn(() => ({ where: selectWhere, orderBy: vi.fn() }));
	const select = vi.fn(() => ({ from: selectFrom }));

	const values = vi.fn().mockResolvedValue(undefined);
	const insert = vi.fn(() => ({ values }));

	const updateWhere = vi.fn().mockResolvedValue(undefined);
	const set = vi.fn((patch: Record<string, unknown>) => ({ where: updateWhere, patch }));
	const update = vi.fn(() => ({ set }));

	return { db: { select, insert, update } as never, spies: { insert, values, update, set } };
}

describe('recordAudit', () => {
	it('inserts a first sighting and stamps both timestamps', async () => {
		const { db, spies } = makeDb([]);
		await recordAudit(db, auditResult([ref()], 'valid'), '2026-08-08T12:00:00.000Z');

		expect(spies.values).toHaveBeenCalledWith(
			expect.objectContaining({
				pageId: 10904,
				location: 'follow-up email',
				status: 'valid',
				firstSeenAt: '2026-08-08T12:00:00.000Z',
				lastSeenAt: '2026-08-08T12:00:00.000Z',
			}),
		);
	});

	it('does not announce a brand-new link that already works', async () => {
		const { db } = makeDb([]);
		const changes = await recordAudit(db, auditResult([ref()], 'valid'));
		expect(changes).toEqual([]);
	});

	it('announces a brand-new link that is already broken', async () => {
		const { db } = makeDb([]);
		const changes = await recordAudit(db, auditResult([ref()], 'broken'));
		expect(changes).toEqual([{ ref: ref(), from: null, to: 'broken' }]);
	});

	// The point of the ledger: an hourly job re-checks everything, so without
	// this the channel could not tell a fresh breakage from an old one.
	it('reports a valid→broken transition as a change', async () => {
		const { db, spies } = makeDb([
			{ id: 7, status: 'valid', firstSeenAt: '2026-08-01T00:00:00.000Z' },
		]);
		const changes = await recordAudit(
			db,
			auditResult([ref()], 'broken'),
			'2026-08-08T12:00:00.000Z',
		);

		expect(changes).toEqual([{ ref: ref(), from: 'valid', to: 'broken' }]);
		expect(spies.set).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 'broken',
				previousStatus: 'valid',
				statusChangedAt: '2026-08-08T12:00:00.000Z',
			}),
		);
	});

	it('treats a still-broken link as no change, and leaves firstSeenAt alone', async () => {
		const { db, spies } = makeDb([
			{ id: 7, status: 'broken', firstSeenAt: '2026-08-01T00:00:00.000Z' },
		]);
		const changes = await recordAudit(
			db,
			auditResult([ref()], 'broken'),
			'2026-08-08T12:00:00.000Z',
		);

		expect(changes).toEqual([]);
		const patch = spies.set.mock.calls[0][0];
		expect(patch.lastSeenAt).toBe('2026-08-08T12:00:00.000Z');
		expect(patch).not.toHaveProperty('firstSeenAt');
		expect(patch).not.toHaveProperty('statusChangedAt');
	});

	it('keeps the same link in two locations as two independent sightings', async () => {
		const { db, spies } = makeDb([]);
		await recordAudit(
			db,
			auditResult(
				[ref({ location: 'follow-up email' }), ref({ location: 'follow-up text' })],
				'broken',
			),
		);
		expect(spies.insert).toHaveBeenCalledTimes(2);
	});
});

describe('formatChanges', () => {
	it('is silent when nothing changed', () => {
		expect(formatChanges([])).toBe('');
	});

	it('calls out newly broken and newly fixed separately', () => {
		const changes: SightingChange[] = [
			{ ref: ref(), from: 'valid', to: 'broken' },
			{ ref: ref({ pageId: 1, pageName: 'Welcome Page' }), from: 'broken', to: 'valid' },
		];
		const msg = formatChanges(changes);
		expect(msg).toMatch(/Newly broken[\s\S]*Women’s Caucus/);
		expect(msg).toMatch(/Fixed[\s\S]*Welcome Page/);
	});

	it('does not report a link going unknown as a fix', () => {
		const msg = formatChanges([{ ref: ref(), from: 'broken', to: 'unknown' }]);
		expect(msg).not.toMatch(/Fixed/);
	});
});
