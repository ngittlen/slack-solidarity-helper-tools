// Normalizes rows from Solidarity's `/v1/user_actions` and `/v1/event_rsvps`
// into something the member page can render.
//
// Why this is defensive rather than a plain interface: neither endpoint's
// response schema is published. The reference documents their *query*
// parameters and nothing else — no field names, no sort order. So instead of
// asserting a shape we can't verify, we probe an ordered list of plausible keys
// for each thing we need, sort by timestamp ourselves, and degrade to a generic
// key/value display when a row doesn't look like anything we recognize.
//
// Pure and network-free so the whole probe/sort/degrade path is unit-testable
// without mocking fetch.

export interface NormalizedActivity {
	/** Stable-ish key for `{#each}`; falls back to the row's index. */
	key: string;
	/** Human label; '' when nothing plausible was found. */
	title: string;
	/** Secondary line — e.g. whether an RSVP was actually attended. Cleared on a
	 *  collapsed entry whose rows disagreed, so a group never claims of six
	 *  sessions what was only true of the most recent one. */
	detail: string;
	/** Identifies the thing this row is *about* (an event, an action page) so
	 *  repeat rows can be collapsed. null means "never collapse this one". */
	groupKey: string | null;
	/** How many rows this entry stands for — 1 unless rows were collapsed. */
	count: number;
	/** ISO-8601, or null when no timestamp field was recognized. */
	occurredAt: string | null;
	/** Sort key in epoch ms; null sorts last. */
	occurredAtMs: number | null;
	/** True when neither a title nor a timestamp could be probed — the page
	 *  renders `extras` instead of a formatted row, so a schema change reads as
	 *  "we don't recognize this" rather than as "this member did nothing". */
	unknownShape: boolean;
	/** A few scalar fields from the raw row, for that degraded display. */
	extras: { label: string; value: string }[];
}

// Ordered by likelihood; first key that yields a usable value wins.
const TIMESTAMP_KEYS = [
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
];

const TITLE_KEYS = [
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
];

const NESTED_TITLE_PATHS = [
	['page', 'title'],
	['page', 'name'],
	['event', 'title'],
	['event', 'name'],
	['action', 'title'],
	['action', 'name'],
	['session', 'title'],
	['session', 'name'],
	['form', 'title'],
];

const ID_KEYS = ['id', 'action_id', 'rsvp_id', 'uuid'];

/**
 * Resolves a row to a label the probes can't find on their own.
 *
 * Both endpoints turned out to reference their subject by id rather than
 * naming it — `user_actions` has `action_page_id`, `event_rsvps` has
 * `event_id` — so without this every row would render as "Untitled". The
 * caller supplies a lookup built from the cached /v1/pages and /v1/events
 * lists. Returns null when the id isn't in the lookup (a page or event
 * deleted since, or a cache built before it existed).
 */
export type TitleResolver = (row: Record<string, unknown>) => string | null;

/** Optional secondary line, e.g. RSVP attendance. */
export type DetailResolver = (row: Record<string, unknown>) => string | null;

/**
 * Identifies what a row is about, so repeats collapse into one entry.
 *
 * Both feeds are per-*occurrence*: a weekly event books one RSVP row per
 * session, and its signup page books one action row per signup. Left alone, a
 * member who committed to six weeks of the same canvass fills the whole
 * five-row feed with six identical lines and buries everything else they did.
 * Returning null opts a row out of collapsing entirely.
 */
export type GroupKeyResolver = (row: Record<string, unknown>) => string | null;

export interface NormalizeOptions {
	resolveTitle?: TitleResolver;
	resolveDetail?: DetailResolver;
	resolveGroupKey?: GroupKeyResolver;
}

// `extras` is the one path where undocumented upstream fields reach the
// browser, and the entire premise of this page is showing activity *without*
// dumping someone's personal record. Anything that looks like contact or
// identity data is withheld even in the degraded view.
const SENSITIVE_KEYS = new Set([
	'email',
	'email_address',
	'phone',
	'phone_number',
	'address',
	'address1',
	'address2',
	'zip',
	'zip_code',
	'first_name',
	'last_name',
	'full_name',
	'user',
	'user_id',
	'custom_user_properties',
	'other_emails',
	'other_phone_numbers',
]);

const MAX_EXTRAS = 6;
const MAX_EXTRA_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce an unknown value to epoch ms.
 *
 * Numbers are ambiguous: Solidarity uses epoch *seconds* for its `_since`
 * filters, but plenty of APIs return ms. Discriminate by magnitude — a
 * seconds-value in the plausible range is ~1e9, a ms-value ~1e12 — rather than
 * guessing, which would put a 2024 timestamp in 1970 or vice versa.
 */
function toEpochMs(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		if (value >= 1e12) return value;
		if (value >= 1e9) return value * 1000;
		return null;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

function probeTimestamp(row: Record<string, unknown>): number | null {
	for (const key of TIMESTAMP_KEYS) {
		if (!(key in row)) continue;
		const ms = toEpochMs(row[key]);
		if (ms !== null) return ms;
	}
	return null;
}

function probeTitle(row: Record<string, unknown>): string {
	for (const key of TITLE_KEYS) {
		const value = row[key];
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
	}
	for (const path of NESTED_TITLE_PATHS) {
		let cursor: unknown = row;
		for (const segment of path) {
			if (!isRecord(cursor)) {
				cursor = undefined;
				break;
			}
			cursor = cursor[segment];
		}
		if (typeof cursor === 'string' && cursor.trim() !== '') return cursor.trim();
	}
	return '';
}

function probeId(row: Record<string, unknown>, index: number): string {
	for (const key of ID_KEYS) {
		const value = row[key];
		if (typeof value === 'string' && value !== '') return value;
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return `idx-${index}`;
}

function collectExtras(row: Record<string, unknown>): { label: string; value: string }[] {
	const out: { label: string; value: string }[] = [];
	for (const [key, value] of Object.entries(row)) {
		if (out.length >= MAX_EXTRAS) break;
		if (SENSITIVE_KEYS.has(key.toLowerCase())) continue;
		if (value === null || value === undefined) continue;
		// Scalars only — a nested object in a definition list is noise.
		if (typeof value === 'object') continue;
		const text = String(value);
		if (text.trim() === '') continue;
		out.push({
			label: key,
			value: text.length > MAX_EXTRA_LENGTH ? `${text.slice(0, MAX_EXTRA_LENGTH)}…` : text,
		});
	}
	return out;
}

export function normalizeActivity(
	raw: unknown,
	index: number,
	opts: NormalizeOptions = {},
): NormalizedActivity {
	if (!isRecord(raw)) {
		return {
			key: `idx-${index}`,
			title: '',
			detail: '',
			groupKey: null,
			count: 1,
			occurredAt: null,
			occurredAtMs: null,
			unknownShape: true,
			extras: [],
		};
	}

	const occurredAtMs = probeTimestamp(raw);
	// The caller's lookup wins over the generic probes: it knows which id field
	// this endpoint uses, whereas the probes are guessing at field names.
	const title = opts.resolveTitle?.(raw) ?? probeTitle(raw);
	const unknownShape = title === '' && occurredAtMs === null;

	return {
		key: probeId(raw, index),
		title,
		detail: opts.resolveDetail?.(raw) ?? '',
		// An unrecognized row renders its raw fields, so collapsing it would hide
		// exactly the evidence that view exists to show.
		groupKey: unknownShape ? null : (opts.resolveGroupKey?.(raw) ?? null),
		count: 1,
		occurredAt: occurredAtMs === null ? null : new Date(occurredAtMs).toISOString(),
		occurredAtMs,
		unknownShape,
		// Only pay for the degraded view when we'll actually render it.
		extras: unknownShape ? collectExtras(raw) : [],
	};
}

/**
 * Fold rows sharing a group key into their newest member, in place of it.
 *
 * Runs on the sorted list *before* the limit is applied, which is the whole
 * point: collapsing six sessions down to one entry has to free the other four
 * slots for different activity, not just shorten the same five rows.
 */
function collapseGroups(items: NormalizedActivity[]): NormalizedActivity[] {
	const out: NormalizedActivity[] = [];
	const seen = new Map<string, NormalizedActivity>();

	for (const item of items) {
		if (item.groupKey === null) {
			out.push(item);
			continue;
		}
		const existing = seen.get(item.groupKey);
		if (!existing) {
			// A copy: the caller's normalized rows stay untouched, and the group's
			// key is derived from what it groups on so it survives a re-render.
			const head = { ...item, key: `group:${item.groupKey}` };
			seen.set(item.groupKey, head);
			out.push(head);
			continue;
		}
		existing.count += 1;
		// "Attended" on a six-session group is a claim about all six. Only keep it
		// when every collapsed row agreed.
		if (existing.detail !== item.detail) existing.detail = '';
	}

	return out;
}

/**
 * Normalize, sort newest-first, collapse repeats, then take `limit`.
 *
 * The sort is ours on purpose. The API's default ordering is unspecified, so
 * asking it for 5 rows could hand back the five *oldest* — we request a full
 * page and pick the recent ones here. Rows with no parseable timestamp sort
 * last rather than being dropped: an action we can't date is still evidence of
 * activity. Ties break on original index so the order is stable.
 *
 * Collapsing happens after the sort, so each group is represented by its most
 * recent row, and before the limit, so `limit` counts distinct things the
 * member did rather than individual occurrences.
 */
export function normalizeActivityList(
	raw: unknown[],
	limit = 5,
	opts: NormalizeOptions = {},
): NormalizedActivity[] {
	const sorted = raw
		.map((row, index) => ({ item: normalizeActivity(row, index, opts), index }))
		.sort((a, b) => {
			const aMs = a.item.occurredAtMs;
			const bMs = b.item.occurredAtMs;
			if (aMs === null && bMs === null) return a.index - b.index;
			if (aMs === null) return 1;
			if (bMs === null) return -1;
			if (aMs !== bMs) return bMs - aMs;
			return a.index - b.index;
		})
		.map((entry) => entry.item);

	return collapseGroups(sorted).slice(0, limit);
}
