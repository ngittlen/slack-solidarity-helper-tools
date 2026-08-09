import { describe, it, expect } from 'vitest';
import { normalizeActivity, normalizeActivityList } from './activity-feed.js';

describe('normalizeActivity — timestamp probing', () => {
	it.each([
		'created_at',
		'createdAt',
		'submitted_at',
		'occurred_at',
		'action_date',
		'completed_at',
		'attended_at',
		'rsvped_at',
		'date',
		'timestamp',
		'inserted_at',
		'updated_at',
	])('recognizes %s', (key) => {
		const out = normalizeActivity({ [key]: '2026-03-04T05:06:07Z', title: 'X' }, 0);
		expect(out.occurredAt).toBe('2026-03-04T05:06:07.000Z');
	});

	it('prefers the earlier key in the probe order', () => {
		const out = normalizeActivity(
			{ created_at: '2026-01-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' },
			0,
		);
		expect(out.occurredAt).toBe('2026-01-01T00:00:00.000Z');
	});

	it('treats a ~1e9 number as epoch seconds', () => {
		const out = normalizeActivity({ created_at: 1772000000 }, 0);
		expect(out.occurredAtMs).toBe(1772000000 * 1000);
	});

	it('treats a ~1e12 number as epoch milliseconds', () => {
		const out = normalizeActivity({ created_at: 1772000000000 }, 0);
		expect(out.occurredAtMs).toBe(1772000000000);
	});

	it('rejects implausibly small numbers rather than dating them to 1970', () => {
		expect(normalizeActivity({ created_at: 42 }, 0).occurredAtMs).toBeNull();
	});

	it.each([null, '', '   ', 'not a date', {}, []])('ignores unusable value %p', (value) => {
		expect(normalizeActivity({ created_at: value, title: 'X' }, 0).occurredAtMs).toBeNull();
	});
});

describe('normalizeActivity — title probing', () => {
	it.each([
		'title',
		'name',
		'action_name',
		'action_type',
		'page_title',
		'page_name',
		'event_name',
		'event_title',
		'form_name',
		'subject',
		'type',
	])('recognizes %s', (key) => {
		expect(normalizeActivity({ [key]: 'Signed the petition' }, 0).title).toBe(
			'Signed the petition',
		);
	});

	it.each([
		[{ page: { title: 'Petition' } }, 'Petition'],
		[{ event: { name: 'Canvass' } }, 'Canvass'],
		[{ session: { title: 'Morning shift' } }, 'Morning shift'],
		[{ action: { name: 'Called rep' } }, 'Called rep'],
	])('falls back to nested paths for %p', (row, expected) => {
		expect(normalizeActivity(row, 0).title).toBe(expected);
	});

	it('trims whitespace and skips blank candidates', () => {
		expect(normalizeActivity({ title: '   ', name: '  Real  ' }, 0).title).toBe('Real');
	});

	it('does not crash on a nested path that hits a non-object', () => {
		expect(normalizeActivity({ page: 'a string' }, 0).title).toBe('');
	});
});

describe('normalizeActivity — unknown shapes', () => {
	it('flags a row with neither a title nor a timestamp', () => {
		const out = normalizeActivity({ foo: 'bar', count: 3 }, 0);
		expect(out.unknownShape).toBe(true);
		expect(out.extras).toEqual([
			{ label: 'foo', value: 'bar' },
			{ label: 'count', value: '3' },
		]);
	});

	it('does not flag a row that has only a timestamp', () => {
		expect(normalizeActivity({ created_at: '2026-01-01T00:00:00Z' }, 0).unknownShape).toBe(false);
	});

	it('does not collect extras when the shape is recognized', () => {
		expect(normalizeActivity({ title: 'X', foo: 'bar' }, 0).extras).toEqual([]);
	});

	it('caps extras at six pairs', () => {
		const row = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, `v${i}`]));
		expect(normalizeActivity(row, 0).extras).toHaveLength(6);
	});

	it('truncates long extra values', () => {
		const out = normalizeActivity({ note: 'x'.repeat(500) }, 0);
		expect(out.extras[0]!.value).toHaveLength(121);
		expect(out.extras[0]!.value.endsWith('…')).toBe(true);
	});

	// The page exists to show activity without dumping someone's record; the
	// degraded view must not become a backdoor around that.
	it.each(['email', 'phone_number', 'address', 'first_name', 'last_name', 'zip_code', 'user_id'])(
		'withholds sensitive key %s from extras',
		(key) => {
			const out = normalizeActivity({ [key]: 'secret', harmless: 'ok' }, 0);
			expect(out.extras.map((e) => e.label)).toEqual(['harmless']);
		},
	);

	it('skips nested objects and blank values in extras', () => {
		const out = normalizeActivity({ nested: { a: 1 }, blank: '  ', good: 'yes' }, 0);
		expect(out.extras).toEqual([{ label: 'good', value: 'yes' }]);
	});

	it('handles a non-object row', () => {
		for (const raw of [null, 'string', 42, []]) {
			const out = normalizeActivity(raw, 3);
			expect(out.unknownShape).toBe(true);
			expect(out.key).toBe('idx-3');
		}
	});
});

describe('normalizeActivity — keys', () => {
	it.each(['id', 'action_id', 'rsvp_id', 'uuid'])('uses %s when present', (key) => {
		expect(normalizeActivity({ [key]: 'abc', title: 'X' }, 0).key).toBe('abc');
	});

	it('stringifies numeric ids', () => {
		expect(normalizeActivity({ id: 77, title: 'X' }, 0).key).toBe('77');
	});

	it('falls back to the index', () => {
		expect(normalizeActivity({ title: 'X' }, 4).key).toBe('idx-4');
	});
});

describe('normalizeActivityList', () => {
	const at = (iso: string, title: string) => ({ created_at: iso, title });

	it('sorts newest first regardless of input order', () => {
		const out = normalizeActivityList([
			at('2026-01-01T00:00:00Z', 'old'),
			at('2026-06-01T00:00:00Z', 'new'),
			at('2026-03-01T00:00:00Z', 'mid'),
		]);
		expect(out.map((a) => a.title)).toEqual(['new', 'mid', 'old']);
	});

	// The whole reason we request a full page and sort locally.
	it('does not trust the API to have sorted already', () => {
		const rows = Array.from({ length: 10 }, (_, i) =>
			at(`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, `d${i + 1}`),
		);
		expect(normalizeActivityList(rows, 5).map((a) => a.title)).toEqual([
			'd10',
			'd9',
			'd8',
			'd7',
			'd6',
		]);
	});

	it('sorts undated rows last rather than dropping them', () => {
		const out = normalizeActivityList([{ title: 'undated' }, at('2026-01-01T00:00:00Z', 'dated')]);
		expect(out.map((a) => a.title)).toEqual(['dated', 'undated']);
	});

	it('breaks ties on original order', () => {
		const out = normalizeActivityList([
			at('2026-01-01T00:00:00Z', 'first'),
			at('2026-01-01T00:00:00Z', 'second'),
		]);
		expect(out.map((a) => a.title)).toEqual(['first', 'second']);
	});

	it('takes only the requested number', () => {
		expect(
			normalizeActivityList(
				Array.from({ length: 40 }, () => ({ title: 'x' })),
				5,
			),
		).toHaveLength(5);
	});

	it('returns [] for an empty list', () => {
		expect(normalizeActivityList([])).toEqual([]);
	});

	it('keeps unknown-shape rows so a schema change is visible', () => {
		const out = normalizeActivityList([{ mystery: 'value' }]);
		expect(out).toHaveLength(1);
		expect(out[0]!.unknownShape).toBe(true);
	});
});

describe('normalizeActivity — caller-supplied resolvers', () => {
	// Both live endpoints reference their subject by id and carry no label, so
	// this path is what keeps every row from rendering as "Untitled".
	it('prefers a resolved title over the generic probes', () => {
		const out = normalizeActivity({ action_page_id: 5597, name: 'ignored' }, 0, {
			resolveTitle: (row) => (row['action_page_id'] === 5597 ? 'Join Abdul for Senate' : null),
		});
		expect(out.title).toBe('Join Abdul for Senate');
	});

	it('falls back to the probes when the resolver returns null', () => {
		const out = normalizeActivity({ title: 'Probed' }, 0, { resolveTitle: () => null });
		expect(out.title).toBe('Probed');
	});

	it('adds a detail line when a resolver supplies one', () => {
		const out = normalizeActivity({ event_id: 1, created_at: '2026-01-01T00:00:00Z' }, 0, {
			resolveTitle: () => 'Phone Bank',
			resolveDetail: () => 'Attended',
		});
		expect(out).toMatchObject({ title: 'Phone Bank', detail: 'Attended' });
	});

	it('defaults detail to an empty string', () => {
		expect(normalizeActivity({ title: 'x' }, 0).detail).toBe('');
	});

	it('a resolved title alone stops a row being flagged unknown', () => {
		const out = normalizeActivity({ action_page_id: 1 }, 0, { resolveTitle: () => 'Something' });
		expect(out.unknownShape).toBe(false);
	});

	it('passes the resolvers through the list helper', () => {
		const out = normalizeActivityList([{ event_id: 7, created_at: '2026-01-01T00:00:00Z' }], 5, {
			resolveTitle: () => 'Resolved',
			resolveDetail: () => 'RSVP’d',
		});
		expect(out[0]).toMatchObject({ title: 'Resolved', detail: 'RSVP’d' });
	});
});

describe('normalizeActivityList — collapsing repeat rows', () => {
	// Rows as both live endpoints actually return them: one per occurrence,
	// referencing the event/page by id with no label of their own.
	const rsvp = (eventId: number, iso: string, sessionId: number) => ({
		id: sessionId,
		event_id: eventId,
		event_session_id: sessionId,
		created_at: iso,
	});

	const rsvpOpts = {
		resolveTitle: (row: Record<string, unknown>) => `Event ${row['event_id']}`,
		resolveGroupKey: (row: Record<string, unknown>) => `event:${row['event_id']}`,
	};

	it('collapses sessions of one event into a single counted entry', () => {
		const out = normalizeActivityList(
			[
				rsvp(1, '2026-01-01T00:00:00Z', 11),
				rsvp(1, '2026-01-08T00:00:00Z', 12),
				rsvp(1, '2026-01-15T00:00:00Z', 13),
			],
			5,
			rsvpOpts,
		);

		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ title: 'Event 1', count: 3 });
	});

	it('dates a group by its most recent session', () => {
		const out = normalizeActivityList(
			[rsvp(1, '2026-01-01T00:00:00Z', 11), rsvp(1, '2026-01-15T00:00:00Z', 12)],
			5,
			rsvpOpts,
		);
		expect(out[0]!.occurredAt).toBe('2026-01-15T00:00:00.000Z');
	});

	// The point of collapsing: freeing the slots the repeats were occupying.
	it('collapses before applying the limit, so other events still make the list', () => {
		const weekly = Array.from({ length: 6 }, (_, i) =>
			rsvp(1, `2026-02-0${i + 1}T00:00:00Z`, 100 + i),
		);
		const others = [2, 3, 4, 5].map((id) => rsvp(id, '2026-01-01T00:00:00Z', id));

		const out = normalizeActivityList([...weekly, ...others], 5, rsvpOpts);

		expect(out.map((a) => a.title)).toEqual([
			'Event 1',
			'Event 2',
			'Event 3',
			'Event 4',
			'Event 5',
		]);
		expect(out[0]!.count).toBe(6);
	});

	it('leaves distinct events uncollapsed and counted as one', () => {
		const out = normalizeActivityList(
			[rsvp(1, '2026-01-01T00:00:00Z', 11), rsvp(2, '2026-01-02T00:00:00Z', 21)],
			5,
			rsvpOpts,
		);
		expect(out).toHaveLength(2);
		expect(out.every((a) => a.count === 1)).toBe(true);
	});

	it('does not collapse anything when no group resolver is supplied', () => {
		const out = normalizeActivityList(
			[rsvp(1, '2026-01-01T00:00:00Z', 11), rsvp(1, '2026-01-08T00:00:00Z', 12)],
			5,
		);
		expect(out).toHaveLength(2);
	});

	it('does not collapse rows whose group key is null', () => {
		const out = normalizeActivityList(
			[{ title: 'A', created_at: '2026-01-01T00:00:00Z' }, { title: 'A' }],
			5,
			{ resolveGroupKey: () => null },
		);
		expect(out).toHaveLength(2);
	});

	// "Attended" against a six-session group would be a claim about all six.
	it('keeps a detail only when every collapsed row agreed on it', () => {
		const agreed = normalizeActivityList(
			[rsvp(1, '2026-01-01T00:00:00Z', 11), rsvp(1, '2026-01-08T00:00:00Z', 12)],
			5,
			{ ...rsvpOpts, resolveDetail: () => 'Attended' },
		);
		expect(agreed[0]!.detail).toBe('Attended');

		const mixed = normalizeActivityList(
			[rsvp(1, '2026-01-01T00:00:00Z', 11), rsvp(1, '2026-01-08T00:00:00Z', 12)],
			5,
			{
				...rsvpOpts,
				resolveDetail: (row) => (row['event_session_id'] === 11 ? 'Attended' : 'RSVP’d'),
			},
		);
		expect(mixed[0]!.detail).toBe('');
	});

	it('gives a group a key derived from what it grouped on', () => {
		const out = normalizeActivityList([rsvp(7, '2026-01-01T00:00:00Z', 11)], 5, rsvpOpts);
		expect(out[0]!.key).toBe('group:event:7');
	});

	// Collapsing an unrecognized row would hide the raw fields that view exists
	// to surface.
	it('never collapses unknown-shape rows', () => {
		const out = normalizeActivityList([{ mystery: 'a' }, { mystery: 'b' }], 5, {
			resolveGroupKey: () => 'same',
		});
		expect(out).toHaveLength(2);
	});
});
