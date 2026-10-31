// Reading and writing the campaign's spreadsheets, as a service account: the
// Packet Tracker tab, and the nightly door report's tabs (replaceTab).
//
// Written like van/client.ts and geocode-batch.ts: config and `fetch` are
// injected and nothing here imports `$env` or `$lib/server`, so it runs under
// `tsx` in scripts/ as well as inside the app. google-env.ts is the one place
// that turns environment into a config object.
//
// ─────────────────────────────────────────────────────────────────────────
// PRIVACY. Read this before changing the logging.
//
// The rows read through here carry canvassers' names and MiniVAN printed list
// numbers, and the cells written carry a volunteer's display name. The list
// number is a CREDENTIAL — it is what pulls a turf's doors down in MiniVAN —
// which is why refresh-reconcile deliberately keeps it out of retained logs
// even while changing it. Nothing in this file may log cell contents, at any
// level. Counts, spreadsheet ids, tab names and HTTP status codes only.
//
// Sending a volunteer's name to the campaign's spreadsheet is a deliberate decision
// recorded in specs/011-turf-checkout-sheet/spec.md and PRIVACY.md: anyone with
// access to that spreadsheet can read them. It is not an implementation detail
// and PRIVACY.md must stay accurate about it.
// ─────────────────────────────────────────────────────────────────────────
//
// In the Packet Tracker the app only ever writes cells on rows the campaign
// already has: it never adds, deletes or moves a row (see
// $lib/van/packet-tracker.ts). Writes are by row number, so the caller re-reads
// the row first and checks it is still the packet it means. replaceTab is the
// exception, and only for a tab the app owns outright: the door report
// (van/daily-door-report.ts) writes a whole tab of its own each night.
//
// Never throws. A Google outage must not fail a sync whose rows are already
// written — every call returns a result the caller can act on, and the ledger
// keeps what is unsent so a later run retries it.

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
/** The spreadsheets, and Drive's metadata of them: when each last changed
 *  (modifiedSince). Never Drive file contents. */
const SCOPE = [
	'https://www.googleapis.com/auth/spreadsheets',
	'https://www.googleapis.com/auth/drive.metadata.readonly',
].join(' ');
/** Pages of Drive's file list read at most: a thousand files each. */
const MAX_DRIVE_PAGES = 10;

/** The status a call reports when the run's deadline left no time to make
 *  it. Not an answer from Google: nothing was sent, and the caller should
 *  simply try again next run. */
export const OUT_OF_TIME = 408;

/** Generous, and still bounded so a hung request cannot eat the sync's budget.
 *  A CEILING, not the budget: a caller passing a deadline gets whichever is
 *  smaller. */
const TIMEOUT_MS = 30_000;
/** Below this there is not enough time left to get an answer, so the call is
 *  not started and the events wait for the next run. */
const MIN_REQUEST_MS = 3_000;

/** Google's answers to a request by a tab id or row that is no longer there:
 *  the values API's "exceeds grid limits", and batchUpdate's own wordings for
 *  a tab id or row past the end. Not a refusal — the tab moved under us. */
export const STALE_TAB =
	/no grid with id|exceeds grid limits|after (the )?last row|outside the grid/i;

/** What an entry the app filled in is highlighted with: Sheets' own yellow. */
const HIGHLIGHT = { red: 1, green: 1, blue: 0 };

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 8_000;
/** Google's quota window: 60 reads, and separately 60 writes, a minute for
 *  this service account. */
const QUOTA_WINDOW_MS = 60_000;
/** Requests a minute this client sends of each kind, for a caller that can
 *  wait (the scheduled run, the nudge) and one that cannot (the claim's live
 *  check). The run is paced under the lower figure, so the gap is the live
 *  checks' to use; both stay under 60 for the requests another machine sends,
 *  which this one cannot count. */
const PACED_PER_MINUTE = 45;
const URGENT_PER_MINUTE = 55;

/** How long a 429 waits when Google names no Retry-After. The quota is 60
 *  reads (or writes) a minute: a retry a second or two later is refused
 *  again and spends another request, where a minute on the oldest have aged
 *  out of the window. */
const RATE_LIMIT_WAIT_MS = 60_000;

/** Refresh this long before the token actually expires, so a token minted at
 *  the top of a run cannot lapse midway through it. */
const TOKEN_SKEW_MS = 60_000;

export type FetchFn = typeof fetch;

/** The fields this needs out of a service-account JSON key. */
export interface ServiceAccountConfig {
	clientEmail: string;
	/** PEM, as Google issues it. */
	privateKey: string;
}

export interface SheetsClientOptions {
	fetchFn?: FetchFn;
	/** Overridable for tests. */
	now?: () => number;
	/** Requests a minute of each kind; see PACED_PER_MINUTE. For tests. */
	quota?: { paced: number; urgent: number };
}

/** How a read waits its turn in the minute's quota. */
interface Urgency {
	/** Someone is waiting on the answer — a volunteer's claim, an admin's
	 *  save: allowed past the scheduled run's pace, into the share of the
	 *  minute kept for them. */
	urgent?: boolean;
	/** Withdraws a read still waiting for a slot, or still in flight: a run
	 *  that stops cancels the reads it started ahead. It answers OUT_OF_TIME
	 *  and has spent nothing if it had not been sent. */
	signal?: AbortSignal;
}

/** Every call returns one of these rather than throwing. `status` is 0 for a
 *  network-level failure, which reads differently from any HTTP answer. */
export type SheetsResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** One option of a drop-down: what it shows, and whether it is text. */
export interface DropdownOption {
	label: string;
	text: boolean;
}

export interface SheetsClient {
	/**
	 * Every row of the tab, as displayed, in a single read.
	 *
	 * One request because Google caps this service account at 60 reads a
	 * minute — a hard limit — and the sync reads every one of the campaign's
	 * few dozen spreadsheets. A missing tab is a 404 rather than a created one:
	 * the tab is the campaign's.
	 */
	readTab(
		input: {
			spreadsheetId: string;
			tabName: string;
			deadline?: number;
		} & Urgency,
	): Promise<SheetsResult<string[][]>>;
	/**
	 * Several tabs of one spreadsheet, as displayed, in a single read: the
	 * quota counts requests, not ranges. In the order asked. A missing tab
	 * fails the whole read, as a 404 — read the tabs one at a time to tell
	 * which.
	 */
	readTabs(
		input: {
			spreadsheetId: string;
			tabNames: readonly string[];
			deadline?: number;
		} & Urgency,
	): Promise<SheetsResult<string[][][]>>;
	/** One row, as displayed — the check just before a write that the row is
	 *  still the packet the caller means. `rowIndex` is 0-based. */
	readRow(input: {
		spreadsheetId: string;
		tabName: string;
		rowIndex: number;
		deadline?: number;
	}): Promise<SheetsResult<string[]>>;
	/** Write single cells on one row, USER_ENTERED, in one request. Cells not
	 *  named are left alone. `[columnIndex, value]`, both 0-based. */
	writeCells(input: {
		spreadsheetId: string;
		tabName: string;
		rowIndex: number;
		cells: ReadonlyArray<readonly [number, string]>;
		deadline?: number;
	}): Promise<SheetsResult<true>>;
	/** Set or remove the highlight on single cells of one row, in one request.
	 *  Only the fill colour is touched; the campaign's number and date formats
	 *  stay. `columns` are 0-based. */
	highlightCells(input: {
		spreadsheetId: string;
		tabName: string;
		rowIndex: number;
		columns: readonly number[];
		on: boolean;
		deadline?: number;
	}): Promise<SheetsResult<true>>;
	/** Take the fill colour off every cell from `fromRowIndex` (0-based) to the
	 *  bottom of the tab, every column, in one request. Values and the
	 *  campaign's other formats stay. */
	clearHighlights(input: {
		spreadsheetId: string;
		tabName: string;
		fromRowIndex: number;
		deadline?: number;
	}): Promise<SheetsResult<true>>;
	/**
	 * The options of a column's drop-down, or null when none of the rows looked
	 * at has one. Looks down `rows` rows from `rowIndex` and takes the first
	 * cell with a drop-down: a paste of plain values strips it from the cells
	 * it lands on, so one row alone may have lost it.
	 *
	 * Each option says whether it is `text`, which decides how it must be
	 * written to still match: a list typed into the rule is always text; one
	 * taken from a range of cells is text or a real time per cell, as that
	 * cell holds it. `rowIndex` and `columnIndex` are 0-based.
	 */
	dropdownOptions(input: {
		spreadsheetId: string;
		tabName: string;
		rowIndex: number;
		rows: number;
		columnIndex: number;
		deadline?: number;
	}): Promise<SheetsResult<DropdownOption[] | null>>;
	/**
	 * Make sure the tab has a row `rowIndex` (0-based), adding rows at the
	 * bottom when it does not. A tab the campaign has filled to its last row
	 * would otherwise refuse every read and write past it.
	 */
	ensureRows(input: {
		spreadsheetId: string;
		tabName: string;
		rowIndex: number;
		deadline?: number;
	}): Promise<SheetsResult<true>>;
	/**
	 * Make the tab hold exactly `rows`, creating it as the spreadsheet's first
	 * tab when it is not there. Everything already on it — values and
	 * formatting — is cleared first, so a rerun overwrites rather than leaving
	 * the tail of a longer earlier write. Only for a tab the app owns.
	 *
	 * `ownedPrefix` is how the app knows the tab is its own: an existing tab
	 * whose A1 does not start with it is somebody else's, and is refused (409)
	 * rather than wiped. `columnWidths`, in pixels, sets the columns' widths;
	 * without it they are fitted to their contents, which a long note in one
	 * cell would stretch across the screen.
	 *
	 * Four requests at most: the lookup, the ownership read or the add, and one
	 * batch that clears, writes, bolds and sizes the columns. Returns the tab's
	 * numeric id, for a `#gid=` link straight to it.
	 */
	replaceTab(input: {
		spreadsheetId: string;
		tabName: string;
		rows: ReadonlyArray<{ cells: ReadonlyArray<string | number>; bold?: boolean }>;
		ownedPrefix?: string;
		columnWidths?: readonly number[];
		/** Move the tab to this position on every write, not only when it is
		 *  added — a tab added later at index 0 would push it along. */
		index?: number;
		deadline?: number;
	}): Promise<SheetsResult<{ sheetId: number }>>;
	/** Whether the spreadsheet is reachable and whether it already has the tab.
	 *  Read-only — what `sheets:check` uses to tell "never shared with us" from
	 *  "shared, no tab" without writing anything. */
	describe(
		input: {
			spreadsheetId: string;
			tabName: string;
			deadline?: number;
		} & Urgency,
	): Promise<SheetsResult<{ title: string; hasTab: boolean; tabs: string[] }>>;
	/**
	 * When each spreadsheet the service account can see last changed, by
	 * spreadsheet id, for those Drive says changed after `since` (ISO). From
	 * Drive, not Sheets: one request a thousand files, none of the Sheets
	 * quota's 60 a minute, so a run can tell which spreadsheets it need not
	 * read. Drive's list may lag an edit by a little; a caller that keeps its
	 * own "read at" until it reads again sees the edit on a later call.
	 */
	modifiedSince(input: {
		since: string;
		deadline?: number;
	}): Promise<SheetsResult<Map<string, string>>>;
}

function base64url(input: string | Buffer): string {
	return Buffer.from(input)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** Retry-After when Google gives one, else the quota's minute. */
function rateLimitWaitMs(retryAfter: string | null): number {
	const parsed = parseInt(retryAfter ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : RATE_LIMIT_WAIT_MS;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
	const parsed = parseInt(retryAfter ?? '', 10);
	if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed * 1000, MAX_BACKOFF_MS);
	return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Google's error envelope is `{error: {message, status}}`; a proxy's 502 is
 *  HTML. Both have to produce something an operator can read. */
function parseError(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
		const message = parsed.error?.message;
		if (message) return message;
	} catch {
		// fall through
	}
	return body.slice(0, 300);
}

/** A whole-tab range for the values API. The tab name is quoted because the
 *  campaign's have spaces in them, and a single quote inside it would otherwise
 *  end the quoting early. */
function tabRange(tabName: string): string {
	return `'${tabName.replace(/'/g, "''")}'`;
}

/** A1 column letters for a 0-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
	let n = index + 1;
	let letters = '';
	while (n > 0) {
		const rem = (n - 1) % 26;
		letters = String.fromCharCode(65 + rem) + letters;
		n = Math.floor((n - 1) / 26);
	}
	return letters;
}

/** Google answers a range naming a tab that is not there with a 400. */
function missingTab<T>(
	res: { ok: false; status: number; error: string },
	tabName: string,
): SheetsResult<T> {
	if (res.status === 400 && /unable to parse range/i.test(res.error)) {
		return { ok: false, status: 404, error: `the spreadsheet has no "${tabName}" tab` };
	}
	return res;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** Rows as Google displays them, every cell a string. */
function displayed(values: unknown[][] | undefined): string[][] {
	return (values ?? []).map((row) => row.map((cell) => String(cell ?? '')));
}

function parseJson<T>(body: string): T | null {
	try {
		return JSON.parse(body) as T;
	} catch {
		return null;
	}
}

export function createSheetsClient(
	config: ServiceAccountConfig,
	options: SheetsClientOptions = {},
): SheetsClient {
	const fetchFn = options.fetchFn ?? fetch;
	const now = options.now ?? Date.now;
	const quota = options.quota ?? { paced: PACED_PER_MINUTE, urgent: URGENT_PER_MINUTE };

	/** When each request of the last minute went out, oldest first, by the
	 *  quota it counts against. */
	const sent: Record<'read' | 'write', number[]> = { read: [], write: [] };

	/**
	 * Wait for room in the minute's quota, and take it. False when the wait
	 * would not leave the caller's deadline time for the request itself: the
	 * caller gets an OUT_OF_TIME and the work waits for the next run, as it
	 * would for a 429 — but without spending a request to learn it.
	 */
	async function slot(
		kind: 'read' | 'write',
		{ urgent, signal }: Urgency,
		deadline: number | undefined,
	): Promise<boolean> {
		const ceiling = urgent ? quota.urgent : quota.paced;
		const times = sent[kind];
		const latest = (deadline ?? now() + TIMEOUT_MS) - MIN_REQUEST_MS;
		for (;;) {
			if (signal?.aborted) return false;
			const t = now();
			while (times.length > 0 && times[0]! <= t - QUOTA_WINDOW_MS) times.shift();
			if (times.length < ceiling) {
				times.push(t);
				return true;
			}
			// The send that has to age out for this one to fit.
			const wait = times[times.length - ceiling]! + QUOTA_WINDOW_MS - t;
			if (t + wait > latest) return false;
			await sleep(wait, signal);
		}
	}

	/** Cached across every spreadsheet in a run — one token serves them all. */
	let token: { value: string; expiresAt: number } | null = null;

	function budget(deadline: number | undefined): number {
		if (deadline === undefined) return TIMEOUT_MS;
		return Math.min(TIMEOUT_MS, deadline - now());
	}

	/** Mint a bearer token with the signed-JWT grant.
	 *
	 *  RS256 over the service account's private key. This is the only
	 *  asymmetric signing in the repo — everything else (oauth-state,
	 *  webhook-token) is HMAC — so it is written out rather than reached for
	 *  from a library: `googleapis` would be a large dependency for one POST. */
	async function accessToken(deadline?: number): Promise<SheetsResult<string>> {
		const cached = token;
		if (cached && cached.expiresAt - TOKEN_SKEW_MS > now()) {
			return { ok: true, value: cached.value };
		}
		// Reads go out in parallel, and without this each would mint its own
		// token on a cold client.
		if (minting) return minting;
		minting = mintToken(deadline).finally(() => {
			minting = null;
		});
		return minting;
	}

	let minting: Promise<SheetsResult<string>> | null = null;

	async function mintToken(deadline?: number): Promise<SheetsResult<string>> {
		const issuedAt = Math.floor(now() / 1000);
		const claims = {
			iss: config.clientEmail,
			scope: SCOPE,
			aud: TOKEN_URL,
			iat: issuedAt,
			exp: issuedAt + 3600,
		};
		const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
			JSON.stringify(claims),
		)}`;

		let assertion: string;
		try {
			const signer = createSign('RSA-SHA256');
			signer.update(signingInput);
			assertion = `${signingInput}.${signer.sign(config.privateKey, 'base64url')}`;
		} catch (err) {
			// A malformed private key fails here, every time, until someone fixes
			// the secret. Reported rather than retried.
			return {
				ok: false,
				status: 0,
				error: `could not sign the token request: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		const timeoutMs = budget(deadline);
		if (timeoutMs < MIN_REQUEST_MS) {
			return { ok: false, status: OUT_OF_TIME, error: 'no time left in the run to mint a token' };
		}

		let res: Response;
		try {
			res = await fetchFn(TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
					assertion,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			return {
				ok: false,
				status: 0,
				error: `token request failed: ${err instanceof Error ? err.name : String(err)}`,
			};
		}

		const body = await res.text().catch(() => '');
		if (!res.ok) {
			console.warn(`[sheets] token request returned ${res.status}`);
			return { ok: false, status: res.status, error: parseError(body) };
		}

		let parsed: { access_token?: string; expires_in?: number };
		try {
			parsed = JSON.parse(body) as typeof parsed;
		} catch {
			return { ok: false, status: res.status, error: 'token response was not JSON' };
		}
		if (!parsed.access_token) {
			return { ok: false, status: res.status, error: 'token response carried no access_token' };
		}

		token = {
			value: parsed.access_token,
			expiresAt: now() + (parsed.expires_in ?? 3600) * 1000,
		};
		return { ok: true, value: token.value };
	}

	/** One authenticated request, retrying 5xx, and a 429 once the minute's
	 *  quota has had time to free up — only when the caller's deadline leaves
	 *  room for that wait, so a run with seconds left gets its 429 at once and
	 *  leaves the rest for the next run. Other 4xx answers come straight back:
	 *  a 403 means the spreadsheet was never shared with the service account,
	 *  and retrying it three more times just spends the run's budget on an
	 *  answer that will not change. */
	async function request(
		url: string,
		init: RequestInit,
		deadline?: number,
		urgency: Urgency = {},
		/** Counted against the Sheets quota. Not a Drive call, which has its own. */
		paced = true,
	): Promise<SheetsResult<string>> {
		const auth = await accessToken(deadline);
		if (!auth.ok) return auth;
		const kind = (init.method ?? 'GET') === 'GET' ? 'read' : 'write';

		let lastError = 'request failed';
		let lastStatus = 0;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const isLast = attempt === MAX_ATTEMPTS - 1;
			const outOfTime = (error: string) => ({ ok: false, status: OUT_OF_TIME, error }) as const;
			if (budget(deadline) < MIN_REQUEST_MS) {
				return outOfTime('no time left in the run for this request');
			}
			if (paced && !(await slot(kind, urgency, deadline))) {
				return outOfTime(
					urgency.signal?.aborted
						? 'withdrawn: the run stopped'
						: "no time left in the run to wait for Google's per-minute quota",
				);
			}
			// After the wait for a slot, which may have used much of the budget.
			const timeoutMs = budget(deadline);
			const timeout = AbortSignal.timeout(timeoutMs);

			let res: Response;
			try {
				res = await fetchFn(url, {
					...init,
					headers: {
						...init.headers,
						Authorization: `Bearer ${auth.value}`,
						'Content-Type': 'application/json',
					},
					signal: urgency.signal ? AbortSignal.any([urgency.signal, timeout]) : timeout,
				});
			} catch (err) {
				if (urgency.signal?.aborted) return outOfTime('withdrawn: the run stopped');
				lastError = `network failure: ${err instanceof Error ? err.name : String(err)}`;
				lastStatus = 0;
				if (!isLast) await sleep(backoffMs(attempt, null), urgency.signal);
				continue;
			}

			const body = await res.text().catch(() => '');
			if (res.ok) return { ok: true, value: body };

			lastStatus = res.status;
			lastError = parseError(body);
			if (res.status === 429) {
				const wait = rateLimitWaitMs(res.headers.get('Retry-After'));
				const room = deadline === undefined ? 0 : deadline - now() - wait;
				if (isLast || room < MIN_REQUEST_MS) {
					return { ok: false, status: 429, error: lastError };
				}
				console.warn(`[sheets] 429 — quota spent, retrying in ${Math.round(wait / 1000)}s`);
				await sleep(wait, urgency.signal);
				continue;
			}
			if (res.status >= 500) {
				if (!isLast) {
					const wait = backoffMs(attempt, res.headers.get('Retry-After'));
					console.warn(`[sheets] ${res.status} — retrying in ${Math.round(wait / 1000)}s`);
					await sleep(wait, urgency.signal);
				}
				continue;
			}
			return { ok: false, status: res.status, error: lastError };
		}
		return { ok: false, status: lastStatus, error: lastError };
	}

	const base = (spreadsheetId: string) => `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}`;

	/** Formatting goes by the tab's numeric id, not its name. Stable for the
	 *  life of a tab, so looked up once per tab: every lookup spends one of the
	 *  minute's 60 reads. The row count comes with it, for `ensureRows`; it
	 *  only grows here, and a tab the campaign shrank answers a write past its
	 *  end with a 400, which drops this and looks again. */
	const tabs = new Map<string, { id: number; rowCount: number }>();
	const tabKey = (spreadsheetId: string, tabName: string) => `${spreadsheetId}\u0000${tabName}`;

	async function tabInfo(
		spreadsheetId: string,
		tabName: string,
		deadline?: number,
	): Promise<SheetsResult<{ id: number; rowCount: number }>> {
		const known = tabs.get(tabKey(spreadsheetId, tabName));
		if (known !== undefined) return { ok: true, value: known };
		const res = await request(
			`${base(spreadsheetId)}?fields=${encodeURIComponent('sheets.properties(sheetId,title,gridProperties.rowCount)')}`,
			{ method: 'GET' },
			deadline,
		);
		if (!res.ok) return res;
		const parsed = parseJson<{
			sheets?: Array<{
				properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } };
			}>;
		}>(res.value);
		const props = parsed?.sheets?.find((s) => s.properties?.title === tabName)?.properties;
		if (typeof props?.sheetId !== 'number') {
			return { ok: false, status: 404, error: `the spreadsheet has no "${tabName}" tab` };
		}
		const info = { id: props.sheetId, rowCount: props.gridProperties?.rowCount ?? 0 };
		tabs.set(tabKey(spreadsheetId, tabName), info);
		return { ok: true, value: info };
	}

	/** Forget a tab's id after Google said it was wrong — but not after a 429 or
	 *  a timeout, where it is fine and a lookup would only spend another read. */
	function forgetTab<T>(res: SheetsResult<T>, spreadsheetId: string, tabName: string) {
		// Only when it is the id Google objects to ("No grid with id: 1234"), or
		// a write past a shrunk tab's end: any other 400 — a protected cell,
		// say — would otherwise cost a fresh lookup on every later call.
		if (!res.ok && (res.status === 404 || (res.status === 400 && STALE_TAB.test(res.error)))) {
			tabs.delete(tabKey(spreadsheetId, tabName));
		}
		return res;
	}

	return {
		async readTab({ spreadsheetId, tabName, deadline, urgent, signal }) {
			const res = await request(
				`${base(spreadsheetId)}/values/${encodeURIComponent(tabRange(tabName))}` +
					`?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
				{ method: 'GET' },
				deadline,
				{ urgent, signal },
			);
			if (!res.ok) return missingTab(res, tabName);
			const body = parseJson<{ values?: unknown[][] }>(res.value);
			return { ok: true, value: displayed(body?.values) };
		},

		async readTabs({ spreadsheetId, tabNames, deadline, urgent, signal }) {
			const ranges = tabNames.map((name) => `ranges=${encodeURIComponent(tabRange(name))}`);
			const res = await request(
				`${base(spreadsheetId)}/values:batchGet?${ranges.join('&')}` +
					`&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
				{ method: 'GET' },
				deadline,
				{ urgent, signal },
			);
			if (!res.ok) return missingTab(res, tabNames.join('" or "'));
			const body = parseJson<{ valueRanges?: Array<{ values?: unknown[][] }> }>(res.value);
			return {
				ok: true,
				value: tabNames.map((_, i) => displayed(body?.valueRanges?.[i]?.values)),
			};
		},

		async readRow({ spreadsheetId, tabName, rowIndex, deadline }) {
			const row = rowIndex + 1;
			const res = await request(
				`${base(spreadsheetId)}/values/${encodeURIComponent(`${tabRange(tabName)}!${row}:${row}`)}` +
					`?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
				{ method: 'GET' },
				deadline,
			);
			if (!res.ok) return missingTab(res, tabName);
			const body = parseJson<{ values?: unknown[][] }>(res.value);
			return { ok: true, value: (body?.values?.[0] ?? []).map((cell) => String(cell ?? '')) };
		},

		async writeCells({ spreadsheetId, tabName, rowIndex, cells, deadline }) {
			if (cells.length === 0) return { ok: true, value: true };
			const res = await request(
				`${base(spreadsheetId)}/values:batchUpdate`,
				{
					method: 'POST',
					body: JSON.stringify({
						valueInputOption: 'USER_ENTERED',
						data: cells.map(([column, value]) => ({
							range: `${tabRange(tabName)}!${columnLetter(column)}${rowIndex + 1}`,
							values: [[value]],
						})),
					}),
				},
				deadline,
			);
			if (!res.ok) return missingTab(res, tabName);
			return { ok: true, value: true };
		},

		async highlightCells({ spreadsheetId, tabName, rowIndex, columns, on, deadline }) {
			if (columns.length === 0) return { ok: true, value: true };
			const id = await tabInfo(spreadsheetId, tabName, deadline);
			if (!id.ok) return id;
			const res = await request(
				`${base(spreadsheetId)}:batchUpdate`,
				{
					method: 'POST',
					body: JSON.stringify({
						requests: columns.map((column) => ({
							repeatCell: {
								range: {
									sheetId: id.value.id,
									startRowIndex: rowIndex,
									endRowIndex: rowIndex + 1,
									startColumnIndex: column,
									endColumnIndex: column + 1,
								},
								// Off is the field named with no colour given: no fill.
								cell: { userEnteredFormat: on ? { backgroundColor: HIGHLIGHT } : {} },
								fields: 'userEnteredFormat.backgroundColor',
							},
						})),
					}),
				},
				deadline,
			);
			// A tab deleted and made again has a new id, which Google answers
			// with a 400; look it up afresh next time.
			if (!res.ok) return forgetTab(res, spreadsheetId, tabName);
			return { ok: true, value: true };
		},

		async clearHighlights({ spreadsheetId, tabName, fromRowIndex, deadline }) {
			const id = await tabInfo(spreadsheetId, tabName, deadline);
			if (!id.ok) return id;
			const res = await request(
				`${base(spreadsheetId)}:batchUpdate`,
				{
					method: 'POST',
					body: JSON.stringify({
						requests: [
							{
								repeatCell: {
									// No end row or columns: to the edge of the tab.
									range: { sheetId: id.value.id, startRowIndex: fromRowIndex },
									cell: { userEnteredFormat: {} },
									fields: 'userEnteredFormat.backgroundColor',
								},
							},
						],
					}),
				},
				deadline,
			);
			if (!res.ok) return forgetTab(res, spreadsheetId, tabName);
			return { ok: true, value: true };
		},

		async ensureRows({ spreadsheetId, tabName, rowIndex, deadline }) {
			const info = await tabInfo(spreadsheetId, tabName, deadline);
			if (!info.ok) return info;
			if (rowIndex < info.value.rowCount) return { ok: true, value: true };
			const add = rowIndex + 1 - info.value.rowCount;
			const res = await request(
				`${base(spreadsheetId)}:batchUpdate`,
				{
					method: 'POST',
					body: JSON.stringify({
						requests: [
							{ appendDimension: { sheetId: info.value.id, dimension: 'ROWS', length: add } },
						],
					}),
				},
				deadline,
			);
			if (!res.ok) return forgetTab(res, spreadsheetId, tabName);
			info.value.rowCount += add;
			return { ok: true, value: true };
		},

		async dropdownOptions({ spreadsheetId, tabName, rowIndex, rows, columnIndex, deadline }) {
			const column = columnLetter(columnIndex);
			const cells = `${tabRange(tabName)}!${column}${rowIndex + 1}:${column}${rowIndex + rows}`;
			const res = await request(
				`${base(spreadsheetId)}?ranges=${encodeURIComponent(cells)}` +
					`&fields=${encodeURIComponent('sheets.data.rowData.values.dataValidation')}`,
				{ method: 'GET' },
				deadline,
			);
			if (!res.ok) return missingTab(res, tabName);
			type Condition = { type?: string; values?: Array<{ userEnteredValue?: string }> };
			const parsed = parseJson<{
				sheets?: Array<{
					data?: Array<{
						rowData?: Array<{ values?: Array<{ dataValidation?: { condition?: Condition } }> }>;
					}>;
				}>;
			}>(res.value);
			const condition = (parsed?.sheets?.[0]?.data?.[0]?.rowData ?? [])
				.map((row) => row.values?.[0]?.dataValidation?.condition)
				.find((c) => c?.type === 'ONE_OF_LIST' || c?.type === 'ONE_OF_RANGE');
			if (!condition) return { ok: true, value: null };
			const values = (condition.values ?? []).map((v) => String(v.userEnteredValue ?? ''));
			if (condition.type === 'ONE_OF_LIST') {
				return {
					ok: true,
					value: values.filter((v) => v.trim()).map((label) => ({ label, text: true })),
				};
			}
			if (!values[0]) return { ok: true, value: null };
			// `=Lists!$A$2:$A$9`: each cell as displayed, and whether it holds
			// text or a real value such as a time.
			// A range on the same tab names no tab, and Google would read it
			// from the spreadsheet's first one.
			const typed = values[0].replace(/^=/, '');
			const range = typed.includes('!') ? typed : `${tabRange(tabName)}!${typed}`;
			const read = await request(
				`${base(spreadsheetId)}?ranges=${encodeURIComponent(range)}` +
					`&fields=${encodeURIComponent('sheets.data.rowData.values(formattedValue,effectiveValue)')}`,
				{ method: 'GET' },
				deadline,
			);
			if (!read.ok) return read;
			const body = parseJson<{
				sheets?: Array<{
					data?: Array<{
						rowData?: Array<{
							values?: Array<{
								formattedValue?: string;
								effectiveValue?: { stringValue?: string };
							}>;
						}>;
					}>;
				}>;
			}>(read.value);
			const options = (body?.sheets?.[0]?.data ?? [])
				.flatMap((d) => d.rowData ?? [])
				.flatMap((row) => row.values ?? [])
				.filter((v) => (v.formattedValue ?? '').trim() !== '')
				.map((v) => ({
					label: v.formattedValue!,
					text: v.effectiveValue?.stringValue !== undefined,
				}));
			return { ok: true, value: options };
		},

		async replaceTab({ spreadsheetId, tabName, rows, ownedPrefix, columnWidths, index, deadline }) {
			// Looked up afresh: a tab someone deleted since the last run would
			// otherwise be written to by a cached id that no longer exists.
			tabs.delete(tabKey(spreadsheetId, tabName));
			const width = Math.max(1, columnWidths?.length ?? 0, ...rows.map((r) => r.cells.length));
			let info = await tabInfo(spreadsheetId, tabName, deadline);
			if (!info.ok && info.status === 404) {
				const added = await request(
					`${base(spreadsheetId)}:batchUpdate`,
					{
						method: 'POST',
						body: JSON.stringify({
							requests: [
								{
									addSheet: {
										properties: {
											title: tabName,
											index: index ?? 0,
											gridProperties: {
												rowCount: Math.max(rows.length, 1),
												columnCount: width,
											},
										},
									},
								},
							],
						}),
					},
					deadline,
				);
				if (!added.ok) return added;
				const sheetId = parseJson<{
					replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
				}>(added.value)?.replies?.[0]?.addSheet?.properties?.sheetId;
				if (typeof sheetId !== 'number') {
					return { ok: false, status: 0, error: 'addSheet answered without a sheet id' };
				}
				const value = { id: sheetId, rowCount: Math.max(rows.length, 1) };
				tabs.set(tabKey(spreadsheetId, tabName), value);
				info = { ok: true, value };
			} else if (info.ok && ownedPrefix !== undefined) {
				// Already there: clear it only if it is the app's own.
				const a1 = await request(
					`${base(spreadsheetId)}/values/${encodeURIComponent(`${tabRange(tabName)}!A1`)}`,
					{ method: 'GET' },
					deadline,
				);
				if (!a1.ok) return a1;
				const first = String(parseJson<{ values?: unknown[][] }>(a1.value)?.values?.[0]?.[0] ?? '');
				if (first !== '' && !first.startsWith(ownedPrefix)) {
					return {
						ok: false,
						status: 409,
						error: `the spreadsheet already has a "${tabName}" tab that this app did not write`,
					};
				}
			}
			if (!info.ok) return info;
			const sheetId = info.value.id;

			const requests: unknown[] = [];
			if (rows.length > info.value.rowCount) {
				requests.push({
					appendDimension: {
						sheetId,
						dimension: 'ROWS',
						length: rows.length - info.value.rowCount,
					},
				});
			}
			requests.push(
				{
					updateCells: {
						range: { sheetId },
						fields: 'userEnteredValue,userEnteredFormat',
					},
				},
				{
					updateCells: {
						start: { sheetId, rowIndex: 0, columnIndex: 0 },
						rows: rows.map((row) => ({
							values: row.cells.map((cell) => ({
								userEnteredValue:
									typeof cell === 'number' ? { numberValue: cell } : { stringValue: cell },
								...(row.bold ? { userEnteredFormat: { textFormat: { bold: true } } } : {}),
							})),
						})),
						fields: 'userEnteredValue,userEnteredFormat.textFormat.bold',
					},
				},
				...(columnWidths
					? columnWidths.map((pixelSize, i) => ({
							updateDimensionProperties: {
								range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
								properties: { pixelSize },
								fields: 'pixelSize',
							},
						}))
					: [
							{
								autoResizeDimensions: {
									dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: width },
								},
							},
						]),
				...(index !== undefined
					? [
							{
								updateSheetProperties: {
									properties: { sheetId, index },
									fields: 'index',
								},
							},
						]
					: []),
			);
			const res = await request(
				`${base(spreadsheetId)}:batchUpdate`,
				{ method: 'POST', body: JSON.stringify({ requests }) },
				deadline,
			);
			if (!res.ok) return forgetTab(res, spreadsheetId, tabName);
			info.value.rowCount = Math.max(info.value.rowCount, rows.length);
			return { ok: true, value: { sheetId } };
		},

		async describe({ spreadsheetId, tabName, deadline, urgent, signal }) {
			const res = await request(
				`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`,
				{ method: 'GET' },
				deadline,
				{ urgent, signal },
			);
			if (!res.ok) return res;
			try {
				const parsed = JSON.parse(res.value) as {
					properties?: { title?: string };
					sheets?: Array<{ properties?: { title?: string } }>;
				};
				const tabs = (parsed.sheets ?? [])
					.map((s) => s.properties?.title ?? '')
					.filter((t): t is string => Boolean(t));
				return {
					ok: true,
					value: {
						title: parsed.properties?.title ?? '',
						hasTab: tabs.includes(tabName),
						tabs,
					},
				};
			} catch {
				return { ok: false, status: 0, error: 'spreadsheet metadata was not JSON' };
			}
		},

		async modifiedSince({ since, deadline }) {
			const changed = new Map<string, string>();
			const query = [
				"mimeType = 'application/vnd.google-apps.spreadsheet'",
				`modifiedTime > '${since}'`,
				'trashed = false',
			].join(' and ');
			let pageToken: string | undefined;
			for (let page = 0; page < MAX_DRIVE_PAGES; page++) {
				const params = new URLSearchParams({
					q: query,
					fields: 'nextPageToken,files(id,modifiedTime)',
					pageSize: '1000',
					corpora: 'allDrives',
					includeItemsFromAllDrives: 'true',
					supportsAllDrives: 'true',
				});
				if (pageToken) params.set('pageToken', pageToken);
				const res = await request(
					`${DRIVE_FILES}?${params}`,
					{ method: 'GET' },
					deadline,
					{},
					false,
				);
				if (!res.ok) return res;
				const body = parseJson<{
					nextPageToken?: string;
					files?: Array<{ id?: string; modifiedTime?: string }>;
				}>(res.value);
				if (!body) return { ok: false, status: 0, error: 'Drive file list was not JSON' };
				for (const file of body.files ?? []) {
					if (file.id && file.modifiedTime) changed.set(file.id, file.modifiedTime);
				}
				pageToken = body.nextPageToken;
				if (!pageToken) return { ok: true, value: changed };
			}
			// A partial list would read as "unchanged" for files on the pages
			// not read.
			return { ok: false, status: 0, error: `Drive listed more than ${MAX_DRIVE_PAGES} pages` };
		},
	};
}
