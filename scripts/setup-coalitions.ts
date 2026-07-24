/**
 * Provision Solidarity coalitions: one custom user property (checkbox) plus
 * one user list per coalition, so the /settings Coalition ↔ Slack channel
 * section has something to map and reconcile against.
 *
 * The list filter uses the QueryBuilder rule shape verified against this
 * org's live data (2026-07-05): the "Experienced Petitioners" list filters
 * the checkbox property "Petitioner Experience" (key petitioner-experience)
 * with exactly
 *
 *   {"rules":[{"id":"cup.petitioner-experience","type":"string",
 *     "input":"select","value":"true","operator":"equal"}],
 *    "valid":true,"condition":"AND"}
 *
 * — the same "property = true" convention the reconcile endpoint writes.
 *
 * Usage (from project root):
 *
 *   # See what exists — property keys, list ids, raw filter parameters:
 *   npx tsx --env-file=.env scripts/setup-coalitions.ts inspect
 *
 *   # Dry-run (default) — prints every payload it WOULD post:
 *   npx tsx --env-file=.env scripts/setup-coalitions.ts create "Clergy" "Students for Abdul"
 *
 *   # Actually create:
 *   npx tsx --env-file=.env scripts/setup-coalitions.ts create --apply "Clergy" "Students for Abdul"
 *
 * Scope defaults to the Organization scope found on existing user lists;
 * override with --scope-id <n> if needed.
 *
 * Idempotent: coalitions whose property or list already exists are skipped
 * (matched by label/name, case-insensitive), so re-running is safe. After an
 * --apply run, verify each new list in the Solidarity UI, then map property +
 * list + channel on /settings.
 *
 * Required env vars: SOLIDARITY_API_TOKEN
 */

import { fetchPaginated, fetchWithRetry } from '../src/lib/server/solidarity-paginate.js';

const API_BASE = 'https://api.solidarity.tech';
const TOKEN = process.env.SOLIDARITY_API_TOKEN ?? '';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv[0];
const APPLY = argv.includes('--apply');

function flagValue(name: string): string | undefined {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
}

/** Positional args after the subcommand, minus flags and their values. */
function positionals(): string[] {
	const out: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--apply') continue;
		if (arg.startsWith('--')) {
			i++; // skip the flag's value
			continue;
		}
		out.push(arg);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Solidarity API helpers
// ---------------------------------------------------------------------------

interface RawProperty {
	id?: number;
	/** Machine key, e.g. "petitioner-experience" — referenced as cup.<key> in list filters. */
	key?: string;
	name?: string;
	label?: string;
	field_type?: string;
	scope_id?: number;
	scope_type?: string;
}

interface RawUserList {
	id?: number;
	name?: string;
	scope_id?: number;
	scope_type?: string;
	parameters?: unknown;
}

function propertyLabel(p: RawProperty): string {
	return p.label ?? p.name ?? p.key ?? '';
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
	// A 429 rejects the POST before it applies, so a bounded retry is safe.
	const res = await fetchWithRetry(
		`${API_BASE}${path}`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		},
		`POST ${path}`,
		'setup-coalitions',
		{ retriesUsed: 0 },
	);
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`POST ${path} returned ${res.status}: ${text}`);
	}
	try {
		const parsed = JSON.parse(text) as { data?: unknown };
		return parsed.data ?? parsed;
	} catch {
		return null;
	}
}

function getProperties(): Promise<RawProperty[]> {
	return fetchPaginated<RawProperty>(
		TOKEN,
		'/v1/custom_user_properties',
		'/v1/custom_user_properties',
		'',
		'setup-coalitions',
	);
}

function getUserLists(): Promise<RawUserList[]> {
	return fetchPaginated<RawUserList>(TOKEN, '/v1/user_lists', '/v1/user_lists', '', 'setup-coalitions');
}

// ---------------------------------------------------------------------------
// inspect — show properties and lists (including raw QueryBuilder parameters)
// ---------------------------------------------------------------------------

async function inspect(): Promise<void> {
	const [properties, lists] = await Promise.all([getProperties(), getUserLists()]);

	console.log('=== Custom user properties ===');
	for (const p of properties) {
		console.log(
			`  id=${p.id}  key=${p.key ?? '?'}  field_type=${p.field_type ?? '?'}  scope=${p.scope_type ?? '?'}/${p.scope_id ?? '?'}  label="${propertyLabel(p)}"`,
		);
	}

	console.log('\n=== User lists ===');
	for (const l of lists) {
		console.log(`  id=${l.id}  scope=${l.scope_type ?? '?'}/${l.scope_id ?? '?'}  name="${l.name ?? '?'}"`);
		if (l.parameters !== undefined) {
			console.log(`    parameters: ${JSON.stringify(l.parameters)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// create — ensure a checkbox property + "property = true" list per coalition
// ---------------------------------------------------------------------------

/** The verified filter: coalition checkbox property is set to "true". */
function coalitionListParameters(propertyKey: string): unknown {
	return {
		rules: [
			{
				id: `cup.${propertyKey}`,
				type: 'string',
				input: 'select',
				value: 'true',
				operator: 'equal',
			},
		],
		valid: true,
		condition: 'AND',
	};
}

async function create(): Promise<void> {
	const names = positionals();
	if (names.length === 0) {
		console.error(
			'Usage: setup-coalitions.ts create [--apply] [--scope-id <n>] "<Coalition>" ...',
		);
		process.exit(1);
	}

	const [properties, lists] = await Promise.all([getProperties(), getUserLists()]);

	// Coalition properties and lists are org-wide. Default to the Organization
	// scope the existing lists live in.
	const scopeIdFlag = flagValue('--scope-id');
	const orgList = lists.find((l) => l.scope_type === 'Organization' && typeof l.scope_id === 'number');
	const scopeId = scopeIdFlag !== undefined ? parseInt(scopeIdFlag, 10) : orgList?.scope_id;
	if (!Number.isFinite(scopeId)) {
		console.error(
			'Could not derive the Organization scope id from existing user lists — pass --scope-id <n>.',
		);
		process.exit(1);
	}
	console.log(`Scope: Organization/${scopeId}\n`);

	if (!APPLY) {
		console.log('DRY RUN — nothing will be created. Re-run with --apply to write.\n');
	}

	const summary: { name: string; key: string | null; listId: number | null }[] = [];

	for (const name of names) {
		console.log(`--- ${name} ---`);

		// 1. Property: reuse if a property already carries this label.
		let property = properties.find((p) => propertyLabel(p).toLowerCase() === name.toLowerCase());
		if (property) {
			console.log(
				`  property exists: key=${property.key} (id=${property.id}, field_type=${property.field_type})`,
			);
			if (property.field_type !== 'checkbox') {
				console.log(
					`  ⚠ field_type is "${property.field_type}", not "checkbox" — the generated list filter` +
						' (value "true", operator "equal") may not match how this property stores values.' +
						' Check the list in the Solidarity UI after creation.',
				);
			}
		} else {
			const payload = {
				label: name,
				field_type: 'checkbox',
				description: `In the ${name} coalition (managed by the Slack helper tools)`,
				scope_type: 'Organization',
				scope_id: scopeId,
			};
			if (APPLY) {
				await apiPost('/v1/custom_user_properties', payload);
				// The create response shape is undocumented — refetch and match by
				// label so we get the server-derived key.
				const refreshed = await getProperties();
				property = refreshed.find((p) => propertyLabel(p).toLowerCase() === name.toLowerCase());
				if (!property?.key) {
					console.error('  ✗ created the property but could not find it on refetch — inspect manually.');
					process.exitCode = 1;
					summary.push({ name, key: null, listId: null });
					continue;
				}
				console.log(`  ✓ created property key=${property.key} (id=${property.id})`);
			} else {
				console.log(`  would create property: ${JSON.stringify(payload)}`);
			}
		}

		// 2. List: reuse if one already carries this coalition's name.
		const listName = `${name} coalition`;
		const existingList = lists.find((l) => (l.name ?? '').toLowerCase() === listName.toLowerCase());
		if (existingList) {
			console.log(`  list exists: "${existingList.name}" (id=${existingList.id})`);
			summary.push({ name, key: property?.key ?? null, listId: existingList.id ?? null });
			continue;
		}

		const key = property?.key ?? '<key-after-create>';
		const listPayload = {
			name: listName,
			scope_type: 'Organization',
			scope_id: scopeId,
			parameters: coalitionListParameters(key),
		};
		if (APPLY) {
			// Reached with a keyless property only when it pre-existed without a
			// usable key — fail loudly rather than sliding into dry-run output
			// mid-apply.
			if (!property?.key) {
				console.error(
					`  ✗ property for "${name}" has no key — cannot create its list; inspect manually.`,
				);
				process.exitCode = 1;
				summary.push({ name, key: null, listId: null });
				continue;
			}
			const created = (await apiPost('/v1/user_lists', listPayload)) as RawUserList | null;
			console.log(`  ✓ created list "${listName}" (id=${created?.id ?? '?'})`);
			summary.push({ name, key: property.key, listId: created?.id ?? null });
		} else {
			console.log(`  would create list: ${JSON.stringify(listPayload)}`);
			summary.push({ name, key: property?.key ?? null, listId: null });
		}
	}

	console.log('\n=== Summary ===');
	for (const s of summary) {
		console.log(`  ${s.name}: property key=${s.key ?? '(pending)'}  list id=${s.listId ?? '(pending)'}`);
	}
	console.log(
		APPLY
			? '\nNext: spot-check each list in the Solidarity UI (filter should read “<property> is true”),\nthen map property + list + channel on /settings (Refresh lists first).'
			: '\nRe-run with --apply to create the above.',
	);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (!TOKEN) {
		console.error('SOLIDARITY_API_TOKEN is not set — run with npx tsx --env-file=.env …');
		process.exit(1);
	}
	if (command === 'inspect') {
		await inspect();
	} else if (command === 'create') {
		await create();
	} else {
		console.error('Usage: setup-coalitions.ts <inspect | create> …  (see the header comment)');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
