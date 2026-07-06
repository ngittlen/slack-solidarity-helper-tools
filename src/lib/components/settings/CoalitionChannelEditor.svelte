<script lang="ts">
	import { errMessage } from '$lib/err-message.js';
	import AutocompletePicker from './AutocompletePicker.svelte';
	import DeleteConfirmButton from './DeleteConfirmButton.svelte';
	import CoalitionReconcilePanel from './CoalitionReconcilePanel.svelte';
	import type { PickerItem } from './picker-types.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	interface ChannelOption {
		id: string;
		name: string;
		isPrivate: boolean;
	}
	interface PropertyOption {
		internalName: string;
		name: string;
	}
	interface ListOption {
		id: number;
		name: string;
	}
	/** Mirrors CoalitionEntry from $lib/server/settings.ts. */
	interface CoalitionRow {
		group: string;
		channelId: string;
		name: string;
		userListId: number | null;
	}

	interface Props {
		channels: ChannelOption[];
		customProperties: PropertyOption[];
		userLists: ListOption[];
		entries: CoalitionRow[];
	}

	let { channels, customProperties, userLists, entries: initialEntries }: Props = $props();

	let entries = $state<CoalitionRow[]>(initialEntries.map((e) => ({ ...e })));

	const channelItems = $derived<PickerItem<string>[]>(
		channels.map((c) => ({
			id: c.id,
			label: `#${c.name}`,
			sublabel: c.isPrivate ? '🔒 private' : undefined,
		})),
	);
	const listItems = $derived<PickerItem<number>[]>(
		userLists.map((l) => ({ id: l.id, label: l.name })),
	);
	// Only offer properties that aren't already mapped.
	const availablePropertyItems = $derived<PickerItem<string>[]>(
		customProperties
			.filter((p) => !entries.some((e) => e.group === p.internalName))
			.map((p) => ({
				id: p.internalName,
				label: p.name,
				sublabel: p.name === p.internalName ? undefined : p.internalName,
			})),
	);

	function rowLabel(row: CoalitionRow): string {
		return row.name || row.group;
	}

	// --- Per-row save state -------------------------------------------------

	interface RowState {
		status: AutosaveStatus;
		error: string | null;
	}
	let rowStates = $state<Record<string, RowState>>({});
	let expandedGroup = $state<string | null>(null);

	function setRowState(group: string, next: RowState): void {
		rowStates = { ...rowStates, [group]: next };
	}

	async function postCoalition(body: Record<string, unknown>): Promise<void> {
		const res = await fetch('/api/settings/coalitions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
		}
	}

	async function upsertRow(row: CoalitionRow): Promise<void> {
		setRowState(row.group, { status: 'saving', error: null });
		try {
			await postCoalition({
				action: 'upsert',
				group: row.group,
				channelId: row.channelId,
				userListId: row.userListId,
			});
			entries = entries.map((e) => (e.group === row.group ? row : e));
			setRowState(row.group, { status: 'saved', error: null });
			setTimeout(() => {
				if (rowStates[row.group]?.status === 'saved') {
					setRowState(row.group, { status: 'idle', error: null });
				}
			}, 2000);
		} catch (e) {
			setRowState(row.group, { status: 'error', error: errMessage(e) });
		}
	}

	async function deleteRow(group: string): Promise<void> {
		// Thrown errors surface in DeleteConfirmButton's own error slot.
		await postCoalition({ action: 'delete', group });
		entries = entries.filter((e) => e.group !== group);
		if (expandedGroup === group) expandedGroup = null;
	}

	// --- Add flow -----------------------------------------------------------

	let newGroup = $state<string | null>(null);
	let newChannelId = $state<string | null>(null);
	let newListId = $state<number | null>(null);
	let adding = $state(false);
	let addError = $state<string | null>(null);

	async function addCoalition(): Promise<void> {
		if (!newGroup || !newChannelId || adding) return;
		adding = true;
		addError = null;
		try {
			await postCoalition({
				action: 'upsert',
				group: newGroup,
				channelId: newChannelId,
				userListId: newListId,
			});
			const property = customProperties.find((p) => p.internalName === newGroup);
			entries = [
				...entries,
				{
					group: newGroup,
					channelId: newChannelId,
					name: property?.name ?? newGroup,
					userListId: newListId,
				},
			];
			newGroup = null;
			newChannelId = null;
			newListId = null;
		} catch (e) {
			addError = errMessage(e);
		} finally {
			adding = false;
		}
	}
</script>

<div class="coalition-editor">
	{#if entries.length === 0}
		<p class="coalition-empty">No coalitions mapped yet — add one below.</p>
	{/if}

	<ul class="coalition-list">
		{#each entries as row (row.group)}
			{@const rowState = rowStates[row.group] ?? { status: 'idle', error: null }}
			<li class="coalition-row">
				<div class="coalition-row-header">
					<div class="coalition-title">
						<span class="coalition-name">{rowLabel(row)}</span>
						<span class="coalition-group">{row.group}</span>
					</div>
					<span class="coalition-status" aria-live="polite" data-status={rowState.status}>
						{rowState.status === 'saving' ? 'Saving…' : rowState.status === 'saved' ? 'Saved' : ''}
					</span>
				</div>

				<div class="coalition-controls">
					<label class="coalition-field">
						<span class="coalition-field-label">Slack channel</span>
						<AutocompletePicker
							items={channelItems}
							value={row.channelId}
							onSelect={(id) => void upsertRow({ ...row, channelId: id })}
							placeholder="Pick a channel…"
							showSublabel={true}
						/>
					</label>
					<label class="coalition-field">
						<span class="coalition-field-label">
							Solidarity user list
							{#if row.userListId === null}
								<span class="coalition-field-hint">(needed to reconcile)</span>
							{/if}
						</span>
						<AutocompletePicker
							items={listItems}
							value={row.userListId}
							onSelect={(id) => void upsertRow({ ...row, userListId: id })}
							placeholder="Pick the coalition’s list…"
						/>
					</label>
					<div class="coalition-actions">
						<button
							type="button"
							class="coalition-reconcile-toggle"
							disabled={row.userListId === null}
							title={row.userListId === null
								? 'Pick the coalition’s Solidarity user list first'
								: undefined}
							onclick={() => (expandedGroup = expandedGroup === row.group ? null : row.group)}
						>
							{expandedGroup === row.group ? 'Close reconcile' : 'Reconcile'}
						</button>
						<DeleteConfirmButton
							label="Remove"
							description={`Remove the “${rowLabel(row)}” coalition mapping? New coalition invites for it will stop working until it’s re-added.`}
							onConfirm={() => deleteRow(row.group)}
						/>
					</div>
				</div>

				{#if rowState.status === 'error' && rowState.error}
					<p class="coalition-error" role="alert">{rowState.error}</p>
				{/if}

				{#if expandedGroup === row.group && row.userListId !== null}
					<CoalitionReconcilePanel group={row.group} label={rowLabel(row)} />
				{/if}
			</li>
		{/each}
	</ul>

	<div class="coalition-add">
		<h3>Add a coalition</h3>
		{#if availablePropertyItems.length === 0}
			<p class="coalition-empty">
				Every Solidarity custom property is already mapped. Create a new property in Solidarity
				for the coalition first, then refresh lists.
			</p>
		{:else}
			<div class="coalition-controls">
				<label class="coalition-field">
					<span class="coalition-field-label">Solidarity custom property</span>
					<AutocompletePicker
						items={availablePropertyItems}
						value={newGroup}
						onSelect={(id) => (newGroup = id)}
						placeholder="Pick the coalition’s property…"
						showSublabel={true}
					/>
				</label>
				<label class="coalition-field">
					<span class="coalition-field-label">Slack channel</span>
					<AutocompletePicker
						items={channelItems}
						value={newChannelId}
						onSelect={(id) => (newChannelId = id)}
						placeholder="Pick a channel…"
						showSublabel={true}
					/>
				</label>
				<label class="coalition-field">
					<span class="coalition-field-label">Solidarity user list (optional)</span>
					<AutocompletePicker
						items={listItems}
						value={newListId}
						onSelect={(id) => (newListId = id)}
						placeholder="Pick the coalition’s list…"
					/>
				</label>
				<button
					type="button"
					class="coalition-add-button"
					disabled={!newGroup || !newChannelId || adding}
					onclick={() => void addCoalition()}
				>
					{adding ? 'Adding…' : 'Add coalition'}
				</button>
			</div>
			{#if addError}
				<p class="coalition-error" role="alert">{addError}</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.coalition-editor {
		margin-top: 12px;
	}

	.coalition-empty {
		color: var(--color-text-muted, #888);
		font-size: 0.9em;
		margin: 8px 0;
	}

	.coalition-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.coalition-row {
		padding: 12px 0;
		border-bottom: 1px solid var(--color-border, #eee);
	}

	.coalition-row-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 6px;
	}

	.coalition-title {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.coalition-name {
		font-weight: 600;
	}

	.coalition-group {
		font-size: 0.85em;
		color: var(--color-text-muted, #888);
		font-family: monospace;
	}

	.coalition-status {
		font-size: 0.85em;
		color: var(--color-text-muted, #888);
		min-width: 60px;
		text-align: right;
	}

	.coalition-status[data-status='saved'] {
		color: var(--color-success, #2e7d32);
	}

	.coalition-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 16px;
	}

	.coalition-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.coalition-field-label {
		font-size: 0.85em;
		color: var(--color-text-muted, #888);
	}

	.coalition-field-hint {
		font-style: italic;
	}

	.coalition-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
	}

	.coalition-reconcile-toggle {
		background: transparent;
		color: var(--color-gold, #b8860b);
		border: 1px solid currentColor;
		border-radius: var(--radius-sm, 4px);
		padding: 4px 10px;
		font: inherit;
		font-size: 0.9em;
		cursor: pointer;
	}

	.coalition-reconcile-toggle:disabled {
		color: var(--color-text-muted, #888);
		cursor: not-allowed;
		opacity: 0.6;
	}

	.coalition-error {
		margin: 6px 0 0;
		font-size: 0.9em;
		color: var(--color-error, #c62828);
	}

	.coalition-add {
		margin-top: 16px;
	}

	.coalition-add h3 {
		margin: 0 0 8px;
		font-size: 1em;
	}

	.coalition-add-button {
		background: var(--color-gold, #b8860b);
		color: #fff;
		border: none;
		border-radius: var(--radius-sm, 4px);
		padding: 6px 14px;
		font: inherit;
		cursor: pointer;
	}

	.coalition-add-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
