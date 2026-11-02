import { describe, expect, it } from 'vitest';
import { aliases, largeScans, sizesFrom } from './rules.js';

const sizes = sizesFrom([
	{ tbl: 'van_turf_roster', idx: 'van_turf_roster_person', stat: '3400000 2' },
	{ tbl: 'van_turf_roster', idx: 'sqlite_autoindex_van_turf_roster_1', stat: '3400000 300 1' },
	{ tbl: 'van_turfs', idx: 'van_turfs_chapter', stat: '72000 700' },
	{ tbl: 'van_turfs', idx: 'van_turfs_live_campaign', stat: '2600 1300' },
	{ tbl: 'app_config', idx: null, stat: '1' },
]);

describe('sizesFrom', () => {
	it('takes each table from its statistics', () => {
		expect(sizes.tables.get('van_turf_roster')).toBe(3_400_000);
		expect(sizes.tables.get('app_config')).toBe(1);
	});

	it('does not take a partial index for its table', () => {
		expect(sizes.tables.get('van_turfs')).toBe(72_000);
		expect(sizes.indexes.get('van_turfs_live_campaign')).toBe(2600);
	});
});

describe('aliases', () => {
	it('reads the tables behind aliases, quoted or not', () => {
		const names = aliases(
			'SELECT r.turf_id FROM van_turf_roster r CROSS JOIN "van_turfs" AS t ON t.turf_id = r.turf_id WHERE 1',
		);
		expect(names.get('r')).toBe('van_turf_roster');
		expect(names.get('t')).toBe('van_turfs');
	});

	it('does not take a keyword for an alias', () => {
		expect(aliases('select * from "van_turfs" where 1').has('where')).toBe(false);
	});
});

describe('largeScans', () => {
	const sql = 'select * from van_turf_roster r join van_turfs t on t.turf_id = r.turf_id';

	it('finds a scan of a large table through its alias', () => {
		expect(
			largeScans(['SCAN r', 'SEARCH t USING INTEGER PRIMARY KEY (rowid=?)'], sql, sizes),
		).toEqual([{ table: 'van_turf_roster', rows: 3_400_000, detail: 'SCAN r' }]);
	});

	it('counts a covering index read end to end, and an automatic index', () => {
		const plan = [
			'SCAN t USING COVERING INDEX van_turfs_chapter',
			'SEARCH r USING AUTOMATIC COVERING INDEX (turf_id=?)',
		];
		expect(largeScans(plan, sql, sizes).map((s) => s.table)).toEqual([
			'van_turfs',
			'van_turf_roster',
		]);
	});

	it('counts an automatic index on a small table, as a missing index', () => {
		const small = sizesFrom([{ tbl: 'van_turf_placements', idx: null, stat: '1872' }]);
		const placed = 'select turf_id from van_turf_placements p where p.chapter_id = ?';
		expect(
			largeScans(['SEARCH p USING AUTOMATIC PARTIAL COVERING INDEX (chapter_id=?)'], placed, small),
		).toEqual([
			{
				table: 'van_turf_placements',
				rows: 1872,
				detail: 'SEARCH p USING AUTOMATIC PARTIAL COVERING INDEX (chapter_id=?)',
			},
		]);
		expect(largeScans(['SCAN p'], placed, small)).toEqual([]);
	});

	it('leaves an automatic index on a subquery or a WITH table alone', () => {
		const withSql =
			'with recent as (select turf_id from van_turf_checkouts) select * from van_turfs t join recent r on r.turf_id = t.turf_id';
		expect(
			largeScans(
				[
					'SEARCH (subquery-1) USING AUTOMATIC COVERING INDEX (k=?)',
					'SEARCH r USING AUTOMATIC COVERING INDEX (turf_id=?)',
				],
				withSql,
				sizes,
			),
		).toEqual([]);
	});

	it('leaves an automatic index on an aliased subquery alone', () => {
		const sub =
			'select * from (select turf_id, max(at) m from van_turf_checkouts group by turf_id) s join van_turfs t on t.turf_id = s.turf_id';
		expect(largeScans(['SEARCH s USING AUTOMATIC COVERING INDEX (turf_id=?)'], sub, sizes)).toEqual(
			[],
		);
	});

	it('takes a function call’s alias for no subquery', () => {
		const counted =
			'select count(*) c from van_turfs t join van_turf_checkouts c on c.turf_id = t.turf_id';
		expect(
			largeScans(['SEARCH c USING AUTOMATIC COVERING INDEX (turf_id=?)'], counted, sizes).map(
				(s) => s.table,
			),
		).toEqual(['van_turf_checkouts']);
	});

	it('counts a scan of a partial index by the rows it covers', () => {
		const plan = ['SCAN t USING INDEX van_turfs_live_campaign'];
		expect(largeScans(plan, sql, sizes)).toEqual([]);
	});

	it('takes an empty index as empty, and an index without statistics at its table', () => {
		const withEmpty = sizesFrom([
			{ tbl: 'van_turfs', idx: 'van_turfs_chapter', stat: '72000 700' },
			{ tbl: 'van_turfs', idx: 'van_turfs_hidden', stat: '0' },
		]);
		expect(largeScans(['SCAN t USING INDEX van_turfs_hidden'], sql, withEmpty)).toEqual([]);
		expect(
			largeScans(['SCAN t USING INDEX van_turfs_unknown'], sql, withEmpty).map((s) => s.rows),
		).toEqual([72_000]);
	});

	it('leaves searches, small tables and subqueries alone', () => {
		const plan = [
			'SEARCH r USING INDEX van_turf_roster_person (person_hash=?)',
			'SCAN app_config',
			'SCAN CONSTANT ROW',
			'SCAN (subquery-1)',
		];
		expect(largeScans(plan, `${sql} cross join app_config`, sizes)).toEqual([]);
	});
});
