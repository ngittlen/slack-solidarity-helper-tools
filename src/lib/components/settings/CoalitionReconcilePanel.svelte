<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { errMessage } from '$lib/err-message.js';

	// Shapes mirror ReconcileDiff/ReconcilePerson from
	// $lib/server/coalition-reconcile.ts (server-only module, so re-declared).
	interface Person {
		email: string;
		name: string;
		slackUserId: string | null;
		solidarityUserId: number | null;
	}

	interface Diff {
		toMark: Person[];
		toInvite: Person[];
		noAccount: Person[];
		notInSlack: Person[];
		consistentCount: number;
		noEmailCount: number;
	}

	interface Props {
		/** Coalition custom-property internal_name. */
		group: string;
		/** Display label for headings. */
		label: string;
	}

	let { group, label }: Props = $props();

	let phase = $state<'loading' | 'error' | 'ready'>('loading');
	let loadError = $state('');
	let diff = $state<Diff | null>(null);

	// Checkbox selections, keyed by email. Everything starts checked — the
	// admin unchecks exceptions rather than building the list by hand.
	const selectedMark = new SvelteSet<string>();
	const selectedInvite = new SvelteSet<string>();
	// Per-person apply failures, keyed by email.
	let rowErrors = $state<Record<string, string>>({});
	let applying = $state<'mark' | 'invite' | null>(null);
	let applySummary = $state('');

	async function load(): Promise<void> {
		phase = 'loading';
		loadError = '';
		applySummary = '';
		rowErrors = {};
		try {
			const res = await fetch(
				`/api/settings/coalitions/reconcile?group=${encodeURIComponent(group)}`,
			);
			const body = (await res.json()) as Diff & { error?: string };
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			diff = body;
			selectedMark.clear();
			selectedInvite.clear();
			for (const p of body.toMark) selectedMark.add(p.email);
			for (const p of body.toInvite) selectedInvite.add(p.email);
			phase = 'ready';
		} catch (e) {
			loadError = errMessage(e);
			phase = 'error';
		}
	}

	// The parent mounts this component when the panel expands, so a mount-time
	// load is the "open → fetch" behavior.
	$effect(() => {
		void load();
	});

	function toggle(set: SvelteSet<string>, email: string): void {
		if (set.has(email)) set.delete(email);
		else set.add(email);
	}

	async function apply(action: 'mark' | 'invite'): Promise<void> {
		if (!diff || applying !== null) return;
		const selected = action === 'mark' ? selectedMark : selectedInvite;
		const source = action === 'mark' ? diff.toMark : diff.toInvite;
		const targets = source.filter((p) => selected.has(p.email));
		if (targets.length === 0) return;

		applying = action;
		applySummary = '';
		try {
			const res = await fetch('/api/settings/coalitions/reconcile', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ group, action, targets }),
			});
			const body = (await res.json()) as {
				results?: { email: string; ok: boolean; error?: string }[];
				error?: string;
			};
			if (!res.ok || !body.results) throw new Error(body.error ?? `HTTP ${res.status}`);

			const succeeded = new Set(body.results.filter((r) => r.ok).map((r) => r.email));
			const failures = body.results.filter((r) => !r.ok);
			const nextErrors = { ...rowErrors };
			for (const f of failures) nextErrors[f.email] = f.error ?? 'failed';
			for (const email of succeeded) delete nextErrors[email];
			rowErrors = nextErrors;

			// Successful people leave their bucket; marked people are now
			// consistent, invited people are consistent once Solidarity's list
			// catches up — either way they're handled.
			if (action === 'mark') {
				diff = {
					...diff,
					toMark: diff.toMark.filter((p) => !succeeded.has(p.email)),
					consistentCount: diff.consistentCount + succeeded.size,
				};
				for (const email of succeeded) selectedMark.delete(email);
			} else {
				diff = {
					...diff,
					toInvite: diff.toInvite.filter((p) => !succeeded.has(p.email)),
					consistentCount: diff.consistentCount + succeeded.size,
				};
				for (const email of succeeded) selectedInvite.delete(email);
			}
			applySummary =
				failures.length === 0
					? `${succeeded.size} ${action === 'mark' ? 'marked' : 'invited'}.`
					: `${succeeded.size} succeeded, ${failures.length} failed — see rows below.`;
		} catch (e) {
			applySummary = `Failed: ${errMessage(e)}`;
		} finally {
			applying = null;
		}
	}
</script>

<div class="reconcile-panel">
	{#if phase === 'loading'}
		<p class="reconcile-muted">Comparing #channel members with the Solidarity list…</p>
	{:else if phase === 'error'}
		<p class="reconcile-error" role="alert">{loadError}</p>
		<button type="button" class="reconcile-retry" onclick={() => void load()}>Retry</button>
	{:else if diff}
		<p class="reconcile-summary">
			{diff.consistentCount} in sync{diff.noEmailCount > 0
				? ` · ${diff.noEmailCount} channel member${diff.noEmailCount === 1 ? '' : 's'} without a Slack email`
				: ''}
			<button type="button" class="reconcile-refresh" onclick={() => void load()}> Re-run </button>
		</p>
		{#if applySummary}
			<p class="reconcile-apply-summary" aria-live="polite">{applySummary}</p>
		{/if}

		<section class="reconcile-section">
			<h4>In the channel, not marked in Solidarity ({diff.toMark.length})</h4>
			{#if diff.toMark.length === 0}
				<p class="reconcile-muted">Nobody — the channel is fully reflected in Solidarity.</p>
			{:else}
				<ul class="reconcile-list">
					{#each diff.toMark as person (person.email)}
						<li>
							<label class="reconcile-person">
								<input
									type="checkbox"
									checked={selectedMark.has(person.email)}
									onchange={() => toggle(selectedMark, person.email)}
								/>
								<span class="reconcile-name">{person.name}</span>
								<span class="reconcile-email">{person.email}</span>
								{#if rowErrors[person.email]}
									<span class="reconcile-row-error">{rowErrors[person.email]}</span>
								{/if}
							</label>
						</li>
					{/each}
				</ul>
				<button
					type="button"
					class="reconcile-apply"
					disabled={applying !== null || selectedMark.size === 0}
					onclick={() => void apply('mark')}
				>
					{applying === 'mark'
						? 'Marking…'
						: `Mark ${selectedMark.size} in Solidarity as “${label}”`}
				</button>
			{/if}
		</section>

		<section class="reconcile-section">
			<h4>Marked in Solidarity, not in the channel ({diff.toInvite.length})</h4>
			{#if diff.toInvite.length === 0}
				<p class="reconcile-muted">Nobody — everyone marked is already in the channel.</p>
			{:else}
				<ul class="reconcile-list">
					{#each diff.toInvite as person (person.email)}
						<li>
							<label class="reconcile-person">
								<input
									type="checkbox"
									checked={selectedInvite.has(person.email)}
									onchange={() => toggle(selectedInvite, person.email)}
								/>
								<span class="reconcile-name">{person.name}</span>
								<span class="reconcile-email">{person.email}</span>
								{#if rowErrors[person.email]}
									<span class="reconcile-row-error">{rowErrors[person.email]}</span>
								{/if}
							</label>
						</li>
					{/each}
				</ul>
				<button
					type="button"
					class="reconcile-apply"
					disabled={applying !== null || selectedInvite.size === 0}
					onclick={() => void apply('invite')}
				>
					{applying === 'invite' ? 'Inviting…' : `Invite ${selectedInvite.size} to the channel`}
				</button>
			{/if}
		</section>

		{#if diff.noAccount.length > 0}
			<section class="reconcile-section">
				<h4>In the channel, no Solidarity account found ({diff.noAccount.length})</h4>
				<p class="reconcile-muted">
					Their Slack email doesn’t match any Solidarity user — handle manually (they may have
					signed up with a different address).
				</p>
				<ul class="reconcile-list reconcile-list-plain">
					{#each diff.noAccount as person (person.email)}
						<li class="reconcile-person">
							<span class="reconcile-name">{person.name}</span>
							<span class="reconcile-email">{person.email}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if diff.notInSlack.length > 0}
			<section class="reconcile-section">
				<h4>Marked in Solidarity, not in the Slack workspace ({diff.notInSlack.length})</h4>
				<p class="reconcile-muted">
					They haven’t joined the Slack yet — nothing to invite them to until they do.
				</p>
				<ul class="reconcile-list reconcile-list-plain">
					{#each diff.notInSlack as person (person.email)}
						<li class="reconcile-person">
							<span class="reconcile-name">{person.name}</span>
							<span class="reconcile-email">{person.email}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>

<style>
	.reconcile-panel {
		margin-top: 8px;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
	}

	.reconcile-summary {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 0 0 4px;
		font-size: 0.9em;
		color: var(--color-text-muted);
	}

	.reconcile-refresh,
	.reconcile-retry {
		background: transparent;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 0.9em;
		color: var(--color-gold);
		cursor: pointer;
		border-bottom: 1px dashed currentColor;
	}

	.reconcile-apply-summary {
		margin: 4px 0;
		font-size: 0.9em;
	}

	.reconcile-section {
		margin-top: 12px;
	}

	.reconcile-section h4 {
		margin: 0 0 6px;
		font-size: 0.95em;
	}

	.reconcile-list {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
		max-height: 260px;
		overflow-y: auto;
	}

	.reconcile-person {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 3px 0;
	}

	.reconcile-list:not(.reconcile-list-plain) .reconcile-person {
		cursor: pointer;
	}

	.reconcile-name {
		font-weight: 500;
	}

	.reconcile-email {
		color: var(--color-text-muted);
		font-size: 0.85em;
	}

	.reconcile-row-error {
		color: var(--color-error);
		font-size: 0.85em;
	}

	.reconcile-muted {
		margin: 0 0 6px;
		color: var(--color-text-muted);
		font-size: 0.9em;
	}

	.reconcile-error {
		margin: 0 0 6px;
		color: var(--color-error);
		font-size: 0.9em;
	}

	.reconcile-apply {
		background: var(--color-gold);
		color: var(--color-action-text);
		border: none;
		border-radius: var(--radius-sm);
		padding: 5px 12px;
		font: inherit;
		font-size: 0.9em;
		cursor: pointer;
	}

	.reconcile-apply:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
