<script lang="ts">
	// A VAN campaign's connection: what its secret provides (described, never
	// shown — the key is not in this page's data at all), a live test of the
	// key, and the export job type that feeds turf shapes.
	//
	// The test lists the folders the key can see, with their ids, because those
	// ids are what an admin types into the folder mapping below — and the export
	// job types, because those ids are per developer and only the key knows them.

	import { untrack } from 'svelte';
	import SettingsRow from './SettingsRow.svelte';
	import { createFieldAutosave } from './use-field-autosave.svelte.js';
	import { errMessage } from '$lib/err-message.js';

	interface Credentials {
		secretName: string;
		state: 'ok' | 'missing' | 'invalid';
		error: string | null;
		appName: string | null;
		databaseMode: 0 | 1 | null;
		source: 'secret' | 'legacy' | null;
	}

	interface TestResult {
		ok: boolean;
		folders: Array<{ folderId: number; name: string }> | null;
		exportJobTypes: Array<{ exportJobTypeId: number; name: string }> | null;
		errors: string[];
	}

	interface Props {
		campaignId: number;
		credentials: Credentials;
		exportJobTypeId: number | null;
		/** The legacy VAN_EXPORT_JOB_TYPE_ID geometry uses while none is picked
		 *  here (primary only); null when there is none. */
		fallbackExportJobTypeId?: number | null;
	}

	let {
		campaignId,
		credentials,
		exportJobTypeId,
		fallbackExportJobTypeId = null,
	}: Props = $props();

	let testing = $state(false);
	let result = $state.raw<TestResult | null>(null);
	let testError = $state<string | null>(null);

	const modeName = { 0: 'My Voters', 1: 'My Campaign' } as const;

	async function runTest(): Promise<void> {
		testing = true;
		testError = null;
		try {
			const res = await fetch(`/api/settings/van-campaigns/${campaignId}/test`, { method: 'POST' });
			const parsed = (await res.json().catch(() => null)) as
				(TestResult & { error?: string }) | null;
			if (!res.ok || !parsed) throw new Error(parsed?.error ?? `Test failed (HTTP ${res.status})`);
			result = parsed;
		} catch (e) {
			testError = errMessage(e);
		} finally {
			testing = false;
		}
	}

	const jobTypeSave = createFieldAutosave<number | null>({
		// Seeded once; the select is the source of truth while the page is open.
		initial: untrack(() => exportJobTypeId),
		parse: (raw) => (raw === '' ? null : Number(raw)),
		debounceMs: 0,
		save: async (value) => {
			const res = await fetch(`/api/settings/van-campaigns/${campaignId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ exportJobTypeId: value }),
			});
			const parsed = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) throw new Error(parsed.error ?? `Save failed (HTTP ${res.status})`);
		},
	});

	/** The types to choose from: the test's, plus the one already saved when it
	 *  is not among them (before a test, or a type this key no longer offers) —
	 *  otherwise the select would show "None" while a type is still set. */
	const jobTypeOptions = $derived.by(() => {
		const listed = result?.exportJobTypes ?? [];
		const saved = jobTypeSave.value;
		return saved === null || listed.some((t) => t.exportJobTypeId === saved)
			? listed
			: [...listed, { exportJobTypeId: saved, name: `Type ${saved}` }];
	});

	$effect(() => () => jobTypeSave.destroy());
</script>

<SettingsRow label="Credentials">
	<dl class="facts">
		<dt>Secret</dt>
		<dd>
			<code>{credentials.secretName}</code>
			{#if credentials.source === 'legacy'}
				<span class="muted">— not set; using the legacy VAN_APP_NAME / VAN_API_KEY</span>
			{/if}
		</dd>
		{#if credentials.state === 'ok'}
			<dt>App name</dt>
			<dd><code>{credentials.appName}</code></dd>
			<dt>Database</dt>
			<dd>
				{credentials.databaseMode === null ? '—' : modeName[credentials.databaseMode]}
			</dd>
			<dt>API key</dt>
			<dd>present (never shown)</dd>
		{:else}
			<dt>Status</dt>
			<dd class="problem">
				{credentials.state === 'missing'
					? `Not set — set ${credentials.secretName} as a Fly secret.`
					: credentials.error}
			</dd>
		{/if}
	</dl>
	<div class="actions">
		<button
			type="button"
			class="button"
			onclick={runTest}
			disabled={testing || credentials.state !== 'ok'}
		>
			{testing ? 'Testing…' : 'Test connection'}
		</button>
		{#if result?.ok && result.errors.length === 0}
			<span class="ok" role="status">The key works.</span>
		{/if}
	</div>
	{#if testError}
		<p class="problem" role="alert">{testError}</p>
	{/if}
	{#if result && result.errors.length > 0}
		<ul class="problem" role="alert">
			{#each result.errors as message (message)}
				<li>{message}</li>
			{/each}
		</ul>
	{/if}
	{#if result?.folders}
		<details class="folders" open={result.folders.length <= 12}>
			<summary>{result.folders.length} folder(s) this key can see</summary>
			<ul>
				{#each result.folders as folder (folder.folderId)}
					<li><code>{folder.folderId}</code> {folder.name}</li>
				{/each}
			</ul>
		</details>
	{/if}
</SettingsRow>

<SettingsRow
	label="Export job type (turf shapes)"
	status={jobTypeSave.status}
	error={jobTypeSave.error}
	onRetry={jobTypeSave.status === 'error' ? jobTypeSave.retry : undefined}
>
	<select
		class="select"
		value={jobTypeSave.value === null ? '' : String(jobTypeSave.value)}
		onchange={jobTypeSave.oninput}
		aria-label="Export job type"
	>
		<option value=""
			>{fallbackExportJobTypeId === null
				? 'None — turf draws as pins'
				: `None here — using VAN_EXPORT_JOB_TYPE_ID (${fallbackExportJobTypeId})`}</option
		>
		{#each jobTypeOptions as type (type.exportJobTypeId)}
			<option value={String(type.exportJobTypeId)}>
				{type.exportJobTypeId} · {type.name}
			</option>
		{/each}
	</select>
	<p class="app-config-note">
		The export that carries each address's coordinates, which is what draws a turf's shape. Pick
		<strong>VoterCircle</strong> — the only type with coordinate columns; SavedListExport has none, and
		every turf then shows as a pin. Run the connection test to list this key's types.
	</p>
</SettingsRow>

<style>
	.facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		margin: 0;
	}

	.facts dt {
		color: var(--color-text-muted);
	}

	.facts dd {
		margin: 0;
	}

	.muted {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-top: var(--space-3);
	}

	.button,
	.select {
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-3);
	}

	.button {
		cursor: pointer;
	}

	.button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.ok {
		color: var(--color-success);
		font-size: var(--font-size-sm);
	}

	.problem {
		color: var(--color-error);
		font-size: var(--font-size-sm);
	}

	ul.problem {
		margin: var(--space-2) 0 0;
		padding-left: 1.2em;
	}

	.folders {
		margin-top: var(--space-3);
		font-size: var(--font-size-sm);
	}

	.folders ul {
		margin: var(--space-2) 0 0;
		padding-left: 1.2em;
		max-height: 16rem;
		overflow-y: auto;
	}
</style>
