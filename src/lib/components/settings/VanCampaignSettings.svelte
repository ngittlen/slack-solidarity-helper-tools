<script lang="ts">
	// A VAN campaign's own switches: its name, whether the sync may re-cut its
	// regions, and whether its checkouts go to a Packet Tracker
	// (specs/012-multi-van-campaigns). Each row autosaves on its own, like the
	// App config rows, through PATCH /api/settings/van-campaigns/<id>.

	import { untrack } from 'svelte';
	import SettingsRow from './SettingsRow.svelte';
	import VanSheetTargetsEditor from './VanSheetTargetsEditor.svelte';
	import { createFieldAutosave } from './use-field-autosave.svelte.js';
	import { DEFAULT_SHEET_TAB_NAME } from '$lib/van/packet-tracker.js';

	interface TargetEntry {
		prefix: string;
		prefixKey: string;
		label: string;
		spreadsheetId: string;
	}

	interface Props {
		campaignId: number;
		credentialKey: string;
		label: string;
		refreshEnabled: boolean;
		sheetsEnabled: boolean;
		sheetTabName: string;
		targets: TargetEntry[];
		serviceAccountEmail: string | null;
		/** After each successful save — so the page can re-read what it shows
		 *  from these fields (its heading, the disable dialog's wording). */
		onSaved?: () => void;
	}

	let {
		campaignId,
		credentialKey,
		label,
		refreshEnabled,
		sheetsEnabled,
		sheetTabName,
		targets,
		serviceAccountEmail,
		onSaved,
	}: Props = $props();

	async function patch(body: Record<string, unknown>): Promise<void> {
		const res = await fetch(`/api/settings/van-campaigns/${campaignId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const parsed = (await res.json().catch(() => ({}))) as { error?: string };
		if (!res.ok) throw new Error(parsed.error ?? `Save failed (HTTP ${res.status})`);
		onSaved?.();
	}

	// Seeded once from the server; from then on the field is the source of
	// truth while the page is open, as in every other settings editor.
	const labelSave = createFieldAutosave<string>({
		initial: untrack(() => label),
		save: (value) => patch({ label: value }),
	});
	const tabSave = createFieldAutosave<string>({
		initial: untrack(() => sheetTabName),
		save: (value) => patch({ sheetTabName: value }),
	});
	const refreshSave = createFieldAutosave<boolean>({
		initial: untrack(() => refreshEnabled),
		parse: (raw) => raw === 'true',
		save: (value) => patch({ refreshEnabled: value }),
	});
	const sheetsSave = createFieldAutosave<boolean>({
		initial: untrack(() => sheetsEnabled),
		parse: (raw) => raw === 'true',
		save: (value) => patch({ sheetsEnabled: value }),
	});

	/** The autosave helper reads `event.target.value`, which on a checkbox is
	 *  the constant "on" — so hand it the checked state as the string it parses. */
	function toggle(save: typeof refreshSave) {
		return (e: Event): void => {
			const checked = (e.currentTarget as HTMLInputElement).checked;
			save.oninput({ target: { value: String(checked) } } as unknown as Event);
		};
	}

	$effect(() => () => {
		labelSave.destroy();
		tabSave.destroy();
		refreshSave.destroy();
		sheetsSave.destroy();
	});
</script>

<SettingsRow
	label="Name"
	status={labelSave.status}
	error={labelSave.error}
	onRetry={labelSave.status === 'error' ? labelSave.retry : undefined}
>
	<input
		class="text-input"
		type="text"
		maxlength="80"
		placeholder={credentialKey}
		value={labelSave.value}
		oninput={labelSave.oninput}
		aria-label="Campaign name"
	/>
	<p class="app-config-note">
		What volunteers see on this campaign's turf and in its Slack messages, and what alerts call it.
		Left empty, it goes by its key, <code>{credentialKey}</code>.
	</p>
</SettingsRow>

<SettingsRow
	id="refresh"
	label="Re-cut regions in VAN"
	status={refreshSave.status}
	error={refreshSave.error}
	onRetry={refreshSave.status === 'error' ? refreshSave.retry : undefined}
>
	<label class="toggle">
		<input type="checkbox" checked={refreshSave.value} onchange={toggle(refreshSave)} />
		<span>Let the sync ask VAN to re-cut this campaign's map regions</span>
	</label>
	<p class="app-config-note">
		A re-cut is how knocked doors leave the counts: after someone finishes a turf, and overnight for
		every mapped folder. But <strong>a re-cut deletes the region's printed lists</strong>: VAN
		replaces every route, the old list numbers stop existing, and the new routes have none until
		someone prints lists for the region again in VAN — the app can't. Until then that turf can't be
		claimed, and any list number already handed out for it is gone. It also re-cuts turf other
		organizers cut, in any shared folder mapped here. Off by default, and only for a campaign that
		has agreed to it.
	</p>
</SettingsRow>

<SettingsRow
	id="sheets"
	label="Google Sheets Packet Tracker"
	status={sheetsSave.status}
	error={sheetsSave.error}
	onRetry={sheetsSave.status === 'error' ? sheetsSave.retry : undefined}
>
	<label class="toggle">
		<input type="checkbox" checked={sheetsSave.value} onchange={toggle(sheetsSave)} />
		<span>Record this campaign's checkouts in its Packet Tracker spreadsheets</span>
	</label>
	<p class="app-config-note">
		Off for a campaign that keeps no Packet Tracker: its turf then never waits on Google. Turning it
		off stops the writes and leaves the spreadsheets as they are.
	</p>
</SettingsRow>

{#if sheetsSave.value}
	<SettingsRow
		label="Packet Tracker tab"
		status={tabSave.status}
		error={tabSave.error}
		onRetry={tabSave.status === 'error' ? tabSave.retry : undefined}
	>
		<input
			class="text-input"
			type="text"
			maxlength="100"
			placeholder={DEFAULT_SHEET_TAB_NAME}
			value={tabSave.value}
			oninput={tabSave.oninput}
			aria-label="Packet Tracker tab name"
		/>
		<p class="app-config-note">
			The tab in every one of this campaign's spreadsheets. The app never creates it. Empty means “{DEFAULT_SHEET_TAB_NAME}”.
		</p>
	</SettingsRow>

	<VanSheetTargetsEditor {campaignId} {targets} {serviceAccountEmail} />
{/if}

<style>
	.toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.text-input {
		width: min(100%, 24rem);
		padding: var(--space-2) var(--space-3);
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.text-input:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 1px;
	}
</style>
