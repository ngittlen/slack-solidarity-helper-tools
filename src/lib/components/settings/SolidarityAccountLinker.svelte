<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import AutocompletePicker from './AutocompletePicker.svelte';
	import type { PickerItem } from './picker-types.js';

	// Manual Slack -> Solidarity link, for members whose Slack email matches no
	// Solidarity record.
	//
	// The roster is thousands of names, so it never reaches the browser: the
	// picker's `onSearch` hook queries the server and the results it returns are
	// the only rows rendered. That also means the picker must NOT re-filter them
	// locally — it would narrow against the last page of results rather than the
	// roster, hiding people who didn't make that page.

	interface Props {
		slackUserId: string;
		/** Shown so the admin can eyeball it against what they're picking. */
		slackEmail: string;
	}

	let { slackUserId, slackEmail }: Props = $props();

	const MIN_CHARS = 2;

	let items = $state<PickerItem<number>[]>([]);
	let selectedId = $state<number | null>(null);
	let searching = $state(false);
	let searchError = $state<string | null>(null);
	let lastQuery = $state('');
	/** A fuller roster is being fetched server-side right now. */
	let refreshing = $state(false);
	/** That fetch is the very first one, so `items` is empty for want of data
	 *  rather than for want of matches. */
	let firstFetch = $state(false);

	// While the server rebuilds the roster the answer will change under us, so
	// re-run the current query until it settles. The walk takes a couple of
	// minutes; polling every few seconds is cheap (each poll is a cache read
	// plus an in-memory search) and means results appear on their own instead
	// of the admin having to retype.
	const POLL_MS = 3000;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => () => {
		if (pollTimer) clearTimeout(pollTimer);
	});

	function schedulePoll(query: string): void {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(() => {
			if (query === lastQuery) void search(query);
		}, POLL_MS);
	}

	let status = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
	let saveError = $state<string | null>(null);

	// What the dropdown says when it has nothing to show — the picker has no way
	// to know whether that means "too short", "still loading" or "no such person".
	const emptyMessage = $derived.by(() => {
		if (searchError) return searchError;
		if (lastQuery.length < MIN_CHARS) return `Type at least ${MIN_CHARS} characters`;
		if (firstFetch) return 'Fetching the complete member list…';
		if (searching) return 'Searching…';
		return 'No matching Solidarity accounts';
	});

	async function search(query: string): Promise<void> {
		lastQuery = query;
		searchError = null;

		if (query.length < MIN_CHARS) {
			items = [];
			searching = false;
			if (pollTimer) clearTimeout(pollTimer);
			return;
		}

		searching = true;
		try {
			const res = await fetch(`/api/members/solidarity-search?q=${encodeURIComponent(query)}`);
			const parsed = (await res.json()) as {
				items?: { id: number; label: string; sublabel: string }[];
				error?: string;
				refreshing?: boolean;
				firstFetch?: boolean;
			};
			if (!res.ok) throw new Error(parsed.error ?? `Search failed (HTTP ${res.status})`);
			// A slower earlier request must not overwrite a newer query's results.
			if (query !== lastQuery) return;
			items = parsed.items ?? [];
			refreshing = parsed.refreshing === true;
			firstFetch = parsed.firstFetch === true;
			if (refreshing) schedulePoll(query);
		} catch (e) {
			if (query !== lastQuery) return;
			items = [];
			refreshing = false;
			firstFetch = false;
			searchError = errMessage(e);
		} finally {
			if (query === lastQuery) searching = false;
		}
	}

	async function link(): Promise<void> {
		if (selectedId === null) return;
		status = 'saving';
		saveError = null;
		try {
			const res = await fetch('/api/members/link', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'link', slackUserId, solidarityUserId: selectedId }),
			});
			if (!res.ok) {
				const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(parsed?.error ?? `Link failed (HTTP ${res.status})`);
			}
			status = 'saved';
			await invalidateAll();
		} catch (e) {
			status = 'error';
			saveError = errMessage(e);
		}
	}
</script>

<div class="linker">
	<p class="linker-headline">Can't find user's solidarity account</p>
	<p class="linker-email">
		Their Slack email is <code>{slackEmail || 'not set'}</code>. Search Solidarity by name or email
		and link the right account.
	</p>

	<SettingsRow
		label="Solidarity account"
		{status}
		error={saveError}
		onRetry={status === 'error' ? link : undefined}
	>
		<div class="linker-controls">
			<AutocompletePicker
				{items}
				value={selectedId}
				onSelect={(id) => (selectedId = id)}
				onSearch={search}
				{emptyMessage}
				placeholder="Search by name or email…"
				showSublabel
			/>
			<button
				type="button"
				class="linker-btn"
				onclick={link}
				disabled={selectedId === null || status === 'saving'}
			>
				{status === 'saving' ? 'Linking…' : 'Link'}
			</button>
		</div>
		{#if refreshing}
			<!-- Shown whether or not there are results: when a stale roster is
			     answering, the admin still needs to know a fuller one is coming
			     before concluding someone isn't in Solidarity at all. -->
			<p class="linker-refreshing" aria-live="polite">
				<span class="linker-spinner" aria-hidden="true"></span>
				Fetching new complete list — this takes a couple of minutes. Results will update on their own.
			</p>
		{/if}
	</SettingsRow>
</div>

<style>
	.linker {
		border: 1px solid var(--color-border, #ccc);
		border-radius: var(--radius-md, 6px);
		padding: 12px 14px;
		background: var(--color-bg-surface, #fff);
	}

	.linker-headline {
		margin: 0 0 4px;
		font-weight: 600;
	}

	.linker-email {
		margin: 0 0 12px;
		color: var(--color-text-muted, #666);
		font-size: 0.92em;
	}

	.linker-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.linker-btn {
		padding: 6px 14px;
		font: inherit;
		cursor: pointer;
		border: 1px solid var(--color-border, #ccc);
		border-radius: var(--radius-md, 6px);
		background: var(--color-bg-surface, #fff);
	}

	.linker-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.linker-refreshing {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 10px 0 0;
		font-size: 0.88em;
		color: var(--color-text-muted, #888);
	}

	.linker-spinner {
		flex: none;
		width: 12px;
		height: 12px;
		border: 2px solid var(--color-border, #ccc);
		border-top-color: var(--color-gold, #b8860b);
		border-radius: 50%;
		animation: linker-spin 0.8s linear infinite;
	}

	@keyframes linker-spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Respect a reduced-motion preference — the text alone still conveys it. */
	@media (prefers-reduced-motion: reduce) {
		.linker-spinner {
			animation: none;
		}
	}
</style>
