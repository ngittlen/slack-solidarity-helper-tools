// What the plan audit counts as a problem: a statement whose plan, under
// production's planner statistics, reads a whole large table, or builds an
// automatic index on a table of any size. See run.ts.
//
// No `$` imports: the runner and the vitest setup both load this.

/** A row of sqlite_stat1, as pull-stats.ts saves it. */
export interface StatRow {
	tbl: string;
	idx: string | null;
	stat: string;
}

/** Tables this size or larger are worth an index on every query. */
export const LARGE_TABLE_ROWS = 10_000;

export interface Sizes {
	tables: Map<string, number>;
	/** A partial index holds only the rows it covers, so it has its own. */
	indexes: Map<string, number>;
}

/** Row counts, from the first figure of each row of statistics. */
export function sizesFrom(stats: readonly StatRow[]): Sizes {
	const tables = new Map<string, number>();
	const indexes = new Map<string, number>();
	for (const { tbl, idx, stat } of stats) {
		const rows = Number.parseInt(stat.split(' ')[0] ?? '', 10);
		if (!Number.isFinite(rows)) continue;
		if (idx !== null) indexes.set(idx, rows);
		if (idx === null || !isPartial(idx, stats)) {
			tables.set(tbl, Math.max(tables.get(tbl) ?? 0, rows));
		}
	}
	return { tables, indexes };
}

/** An index with fewer rows than another on its table covers only some of
 *  them; the table's size is the largest. */
function isPartial(idx: string, stats: readonly StatRow[]): boolean {
	const row = stats.find((s) => s.idx === idx)!;
	const rows = (s: StatRow) => Number.parseInt(s.stat.split(' ')[0] ?? '', 10);
	return stats.some((s) => s.tbl === row.tbl && rows(s) > rows(row));
}

const NOT_ALIASES = new Set([
	'where',
	'on',
	'inner',
	'left',
	'right',
	'cross',
	'join',
	'using',
	'group',
	'order',
	'limit',
	'set',
	'values',
	'natural',
	'outer',
	'full',
	'indexed',
	'not',
	'union',
	'except',
	'intersect',
	'window',
	'having',
	'returning',
]);

/** The table behind each alias in `from` and `join` clauses, so a plan's
 *  `SCAN r` can be read as `SCAN van_turf_roster`. */
export function aliases(sql: string): Map<string, string> {
	const found = new Map<string, string>();
	const clause = /\b(?:from|join|update|into)\s+[`"]?(\w+)[`"]?(?:\s+(?:as\s+)?[`"]?(\w+)[`"]?)?/gi;
	for (const m of sql.matchAll(clause)) {
		const table = m[1]!;
		found.set(table, table);
		const alias = m[2];
		if (alias && !NOT_ALIASES.has(alias.toLowerCase())) found.set(alias, table);
	}
	return found;
}

/** The names a statement gives to what is not a table: those its `WITH`
 *  clause names, and a subquery's alias (`from (select …) s`). */
export function withTables(sql: string): Set<string> {
	const found = new Set<string>();
	for (const name of subqueryAliases(sql)) found.add(name);
	const named =
		/(?:\bwith(?:\s+recursive)?|,)\s*[`"]?(\w+)[`"]?\s*(?:\([^)]*\))?\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/gi;
	for (const m of sql.matchAll(named)) found.add(m[1]!);
	return found;
}

/** The alias after each parenthesised `select`: the name after the `)` that
 *  closes it, counting the parentheses inside. A function call's alias
 *  (`count(*) c`) is not one: its parenthesis opens no `select`. */
function subqueryAliases(sql: string): string[] {
	const found: string[] = [];
	for (const open of sql.matchAll(/\(\s*select\b/gi)) {
		let depth = 0;
		let close = -1;
		for (let i = open.index; i < sql.length; i++) {
			if (sql[i] === '(') depth++;
			else if (sql[i] === ')' && --depth === 0) {
				close = i;
				break;
			}
		}
		if (close < 0) continue;
		const alias = /^\s+(?:as\s+)?[`"]?(\w+)[`"]?/i.exec(sql.slice(close + 1))?.[1];
		if (alias && !NOT_ALIASES.has(alias.toLowerCase())) found.push(alias);
	}
	return found;
}

export interface Scan {
	table: string;
	rows: number;
	detail: string;
}

/**
 * The plan's reads of a whole table: a `SCAN` of a large one, with or without
 * an index (a covering index scanned end to end is still every row); or an
 * automatic index on one of any size. SQLite builds that by reading every row
 * first, and only for a column a statement filters or joins on that has no
 * index: a small table today that grows, read in full by every such
 * statement, which no size threshold would flag until it is big. Not one on
 * a subquery or a `WITH` table, which no index can be put on.
 *
 * Blind to a read of every row by way of an index's range: `SEARCH t USING
 * INDEX i (a>?)` with a bound that every row passes reads as much as a scan,
 * and looks the same as one that reads a day's rows. What it reads depends on
 * the value bound, which the plan does not show.
 */
export function largeScans(
	plan: readonly string[],
	sql: string,
	sizes: Sizes,
	minRows = LARGE_TABLE_ROWS,
): Scan[] {
	const names = aliases(sql);
	const ctes = withTables(sql);
	return plan.flatMap((detail) => {
		const m = /^(?:SCAN (\S+)|SEARCH (\S+) USING AUTOMATIC)/.exec(detail);
		const name = m?.[1] ?? m?.[2];
		if (!name) return [];
		const table = names.get(name) ?? name;
		const automatic = m?.[2] !== undefined && !table.startsWith('(') && !ctes.has(table);
		// A scan of an index reads the index: all of a partial one is only the
		// rows it covers.
		const index = m?.[1] ? /USING (?:COVERING )?INDEX (\w+)/.exec(detail)?.[1] : undefined;
		// An index production has no statistics for is taken at its table's
		// size: unknown is not small. One it counted as empty is.
		const rows =
			(index === undefined ? undefined : sizes.indexes.get(index)) ?? sizes.tables.get(table) ?? 0;
		return automatic || rows >= minRows ? [{ table, rows, detail }] : [];
	});
}
