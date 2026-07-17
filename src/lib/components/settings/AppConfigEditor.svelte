<script lang="ts">
	import { errMessage } from '$lib/err-message.js';
	import { reRank, DEFAULT_RANKING_ALPHA } from '$lib/growth-ranking.js';
	import type { LeaderboardPair, LeaderboardResult } from '$lib/server/weekly-growth-report';
	import SlackLeaderboard from '$lib/components/dashboard/SlackLeaderboard.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import AutocompletePicker from './AutocompletePicker.svelte';
	import type { PickerItem } from './picker-types.js';
	import { createFieldAutosave, type AutosaveStatus } from './use-field-autosave.svelte.js';
	import { isoToLocalInput, localInputToIso } from '$lib/components/dashboard/countdown.js';
	import { extractChannelNames, DEFAULT_WELCOME_DM } from '$lib/welcome-dm.js';

	interface ChannelOption {
		id: string;
		name: string;
		isPrivate: boolean;
	}

	interface Props {
		channels: ChannelOption[];
		/** Effective values from loadSettings ('' / undefined when unset). */
		trackingChannelId: string;
		growthReportChannelId: string;
		rankingAlpha: number | undefined;
		/** Header countdown config ('' when unset). */
		countdownLabel: string;
		countdownEndAt: string;
		/** New-member welcome DM template ('' means "use the built-in default"). */
		welcomeDmMessage: string;
		/** Saved/live leaderboards with UNTRIMMED topChapters — the slider
		 *  preview re-ranks them client-side. */
		leaderboard: LeaderboardPair;
	}

	let {
		channels,
		trackingChannelId,
		growthReportChannelId,
		rankingAlpha,
		countdownLabel,
		countdownEndAt,
		welcomeDmMessage,
		leaderboard,
	}: Props = $props();

	const channelItems = $derived<PickerItem<string>[]>(
		channels.map((c) => ({
			id: c.id,
			label: `#${c.name}`,
			sublabel: c.isPrivate ? '🔒 private' : undefined,
		})),
	);

	async function postAppConfig(patch: Record<string, unknown>): Promise<void> {
		const res = await fetch('/api/settings/app-config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch),
		});
		if (!res.ok) {
			const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
		}
	}

	// --- Channel rows — pessimistic save: the picker's value only moves once
	// the server accepted the pick, so a failed save visibly snaps back.

	interface ChannelField {
		value: string;
		status: AutosaveStatus;
		error: string | null;
		lastFailedId: string | null;
	}

	let tracking = $state<ChannelField>({
		value: trackingChannelId,
		status: 'idle',
		error: null,
		lastFailedId: null,
	});
	let growthReport = $state<ChannelField>({
		value: growthReportChannelId,
		status: 'idle',
		error: null,
		lastFailedId: null,
	});

	async function saveChannel(field: ChannelField, key: string, channelId: string): Promise<void> {
		field.status = 'saving';
		field.error = null;
		try {
			await postAppConfig({ [key]: channelId });
			field.value = channelId;
			field.lastFailedId = null;
			field.status = 'saved';
			setTimeout(() => {
				if (field.status === 'saved') field.status = 'idle';
			}, 2000);
		} catch (e) {
			field.status = 'error';
			field.error = errMessage(e);
			field.lastFailedId = channelId;
		}
	}

	// --- Ranking alpha — debounced autosave; the preview below re-ranks
	// instantly from the local value while the save waits for the slider to
	// settle.

	const alphaSave = createFieldAutosave<number>({
		initial: rankingAlpha ?? DEFAULT_RANKING_ALPHA,
		parse: (raw) => parseFloat(raw),
		save: (value) => postAppConfig({ slackGrowthReportRankingAlpha: value }),
	});

	// --- Header countdown — debounced autosave like the alpha slider. The
	// datetime-local input speaks local time; the API stores canonical ISO, so
	// the value converts on the way in and out. An empty date clears the
	// countdown (the header hides it).

	const countdownLabelSave = createFieldAutosave<string>({
		initial: countdownLabel,
		save: (value) => postAppConfig({ countdownLabel: value }),
	});

	const countdownEndSave = createFieldAutosave<string>({
		initial: isoToLocalInput(countdownEndAt),
		save: (value) => postAppConfig({ countdownEndAt: localInputToIso(value) }),
	});

	// --- Welcome DM template — debounced autosave. `{{channels}}` and friendly
	// `#channel-name` tokens are resolved server-side when the DM is sent; the
	// preview and warning below are computed locally from the channel list.

	const welcomeDmSave = createFieldAutosave<string>({
		initial: welcomeDmMessage,
		save: (value) => postAppConfig({ welcomeDmMessage: value }),
	});

	$effect(() => () => {
		alphaSave.destroy();
		countdownLabelSave.destroy();
		countdownEndSave.destroy();
		welcomeDmSave.destroy();
	});

	const knownChannelNames = $derived(new Set(channels.map((c) => c.name.toLowerCase())));

	// `#name` tokens in the current draft that don't match any known channel —
	// the save endpoint rejects these, so warn before the admin hits that.
	const unknownChannels = $derived(
		extractChannelNames(welcomeDmSave.value).filter((n) => !knownChannelNames.has(n)),
	);

	// Human-readable preview: the effective message (default when blank) with
	// `{{channels}}` shown as a sample chapter channel. `#name` tokens stay as-is
	// since that's exactly how they read in Slack.
	const previewText = $derived(
		(welcomeDmSave.value.trim() || DEFAULT_WELCOME_DM).replaceAll(
			'{{channels}}',
			'#your-chapter-channel',
		),
	);

	// --- "Send this DM to me" test button.

	let testStatus = $state<'idle' | 'sending' | 'sent' | 'error'>('idle');
	let testError = $state<string | null>(null);

	async function sendTestDm(): Promise<void> {
		testStatus = 'sending';
		testError = null;
		try {
			const res = await fetch('/api/settings/welcome-dm-test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ welcomeDmMessage: welcomeDmSave.value }),
			});
			if (!res.ok) {
				const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(parsed?.error ?? `Send failed (HTTP ${res.status})`);
			}
			testStatus = 'sent';
			setTimeout(() => {
				if (testStatus === 'sent') testStatus = 'idle';
			}, 3000);
		} catch (e) {
			testStatus = 'error';
			testError = errMessage(e);
		}
	}

	const previewPair = $derived.by<LeaderboardPair>(() => {
		const alpha = alphaSave.value;
		const rerank = (r: LeaderboardResult): LeaderboardResult =>
			r.ok
				? {
						ok: true,
						leaderboard: {
							...r.leaderboard,
							topChapters: reRank(r.leaderboard.topChapters, alpha),
						},
					}
				: r;
		return { saved: rerank(leaderboard.saved), live: rerank(leaderboard.live) };
	});
</script>

<div class="app-config-editor">
	<SettingsRow
		label="Volunteer-help tracking channel"
		status={tracking.status}
		error={tracking.error}
		onRetry={tracking.lastFailedId
			? () => void saveChannel(tracking, 'slackTrackingChannelId', tracking.lastFailedId!)
			: undefined}
	>
		<AutocompletePicker
			items={channelItems}
			value={tracking.value || null}
			onSelect={(id) => void saveChannel(tracking, 'slackTrackingChannelId', id)}
			placeholder="Pick a channel…"
			showSublabel={true}
		/>
		<p class="app-config-note">
			Where “volunteer needs help joining Slack” webhook notifications are posted.
		</p>
	</SettingsRow>

	<SettingsRow
		label="Weekly growth report channel"
		status={growthReport.status}
		error={growthReport.error}
		onRetry={growthReport.lastFailedId
			? () =>
					void saveChannel(growthReport, 'slackGrowthReportChannelId', growthReport.lastFailedId!)
			: undefined}
	>
		<AutocompletePicker
			items={channelItems}
			value={growthReport.value || null}
			onSelect={(id) => void saveChannel(growthReport, 'slackGrowthReportChannelId', id)}
			placeholder="Pick a channel…"
			showSublabel={true}
		/>
		<p class="app-config-note">Where the Monday chapter-growth leaderboard is posted.</p>
	</SettingsRow>

	<SettingsRow
		label="Header countdown"
		status={countdownEndSave.status === 'idle' ? countdownLabelSave.status : countdownEndSave.status}
		error={countdownEndSave.error ?? countdownLabelSave.error}
		onRetry={countdownEndSave.status === 'error'
			? countdownEndSave.retry
			: countdownLabelSave.status === 'error'
				? countdownLabelSave.retry
				: undefined}
	>
		<div class="countdown-fields">
			<label class="countdown-field">
				<span class="countdown-field-label">Label</span>
				<input
					type="text"
					maxlength="80"
					placeholder="e.g. Petition deadline"
					value={countdownLabelSave.value}
					oninput={countdownLabelSave.oninput}
				/>
			</label>
			<label class="countdown-field">
				<span class="countdown-field-label">Ends at</span>
				<input
					type="datetime-local"
					value={countdownEndSave.value}
					oninput={countdownEndSave.oninput}
				/>
			</label>
		</div>
		<p class="app-config-note">
			Shown as a large days/hours/minutes/seconds countdown at the top of the dashboard, above
			the Solidarity signups chart. Clear the date to hide it.
		</p>
	</SettingsRow>

	<SettingsRow
		label="New-member welcome DM"
		status={welcomeDmSave.status}
		error={welcomeDmSave.error}
		onRetry={welcomeDmSave.status === 'error' ? welcomeDmSave.retry : undefined}
	>
		<textarea
			class="welcome-dm-input"
			rows="4"
			maxlength="3000"
			placeholder={DEFAULT_WELCOME_DM}
			value={welcomeDmSave.value}
			oninput={welcomeDmSave.oninput}
		></textarea>
		<p class="app-config-note">
			The DM sent to each new member after they're added to their chapter channel(s). Use
			<code>{'{{channels}}'}</code> where the list of channels they were added to should appear, and
			write a channel name like <code>#general</code> to link any other channel. Leave blank to use the
			default message.
		</p>
		{#if unknownChannels.length > 0}
			<p class="welcome-dm-warning">
				⚠️ Unknown channel{unknownChannels.length > 1 ? 's' : ''}: {unknownChannels
					.map((n) => `#${n}`)
					.join(', ')} — saving will fail until these match a real channel.
			</p>
		{/if}
		<div class="welcome-dm-preview">
			<span class="welcome-dm-preview-label">Preview</span>
			<p class="welcome-dm-preview-body">{previewText}</p>
		</div>
		<div class="welcome-dm-test">
			<button
				type="button"
				class="welcome-dm-test-btn"
				onclick={sendTestDm}
				disabled={testStatus === 'sending'}
			>
				{testStatus === 'sending' ? 'Sending…' : 'Send this DM to me'}
			</button>
			{#if testStatus === 'sent'}
				<span class="welcome-dm-test-ok">Sent — check your Slack DMs.</span>
			{:else if testStatus === 'error'}
				<span class="welcome-dm-test-err">{testError}</span>
			{/if}
		</div>
	</SettingsRow>

	<SettingsRow
		label="Growth report ranking α = {alphaSave.value.toFixed(2)}"
		status={alphaSave.status}
		error={alphaSave.error}
		onRetry={alphaSave.status === 'error' ? alphaSave.retry : undefined}
	>
		<div class="alpha-control">
			<span class="alpha-end">Biggest gain</span>
			<input
				type="range"
				min="0"
				max="1"
				step="0.05"
				value={alphaSave.value}
				oninput={alphaSave.oninput}
				aria-label="Growth report ranking alpha"
			/>
			<span class="alpha-end">Fastest growth</span>
		</div>
		<p class="app-config-note">
			Chapters are ranked by <code>new joins ÷ (existing + 1)^α</code>. At α&nbsp;=&nbsp;0 the
			report ranks by absolute new joins (large chapters tend to win); at α&nbsp;=&nbsp;1 by pure
			relative growth (small chapters tend to win). Default {DEFAULT_RANKING_ALPHA}. The preview
			below re-ranks the current data as you drag.
		</p>
		<div class="alpha-preview">
			<SlackLeaderboard leaderboard={previewPair} />
		</div>
	</SettingsRow>
</div>

<style>
	.app-config-editor {
		margin-top: 12px;
		max-width: 720px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.app-config-note {
		color: var(--color-text-muted, #888);
		font-size: 0.9em;
		margin: 6px 0 0;
	}

	.app-config-note code {
		font-size: 0.95em;
	}

	.countdown-fields {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}

	.countdown-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.countdown-field-label {
		font-size: 0.8em;
		color: var(--color-text-muted, #888);
	}

	.countdown-field input {
		padding: 6px 8px;
		border: 1px solid var(--color-border, #ccc);
		border-radius: var(--radius-md, 6px);
		font: inherit;
		color: var(--color-text, inherit);
		background: var(--color-surface, #fff);
	}

	.countdown-field input[type='text'] {
		min-width: 220px;
	}

	.alpha-control {
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: 480px;
	}

	.alpha-control input[type='range'] {
		flex: 1;
		accent-color: var(--color-gold, #b8860b);
	}

	.alpha-end {
		font-size: 0.8em;
		color: var(--color-text-muted, #888);
		white-space: nowrap;
	}

	.alpha-preview {
		margin-top: 8px;
	}

	.welcome-dm-input {
		width: 100%;
		max-width: 560px;
		padding: 8px 10px;
		border: 1px solid var(--color-border, #ccc);
		border-radius: var(--radius-md, 6px);
		font: inherit;
		line-height: 1.5;
		color: var(--color-text, inherit);
		background: var(--color-surface, #fff);
		resize: vertical;
	}

	.welcome-dm-warning {
		color: var(--color-danger, #c0392b);
		font-size: 0.9em;
		margin: 6px 0 0;
	}

	.welcome-dm-preview {
		margin-top: 8px;
		max-width: 560px;
		padding: 8px 12px;
		border-left: 3px solid var(--color-gold, #b8860b);
		background: var(--color-surface-alt, rgba(184, 134, 11, 0.06));
		border-radius: var(--radius-md, 6px);
	}

	.welcome-dm-preview-label {
		display: block;
		font-size: 0.75em;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted, #888);
		margin-bottom: 4px;
	}

	.welcome-dm-preview-body {
		margin: 0;
		white-space: pre-wrap;
		line-height: 1.5;
	}

	.welcome-dm-test {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 10px;
	}

	.welcome-dm-test-btn {
		padding: 6px 12px;
		border: 1px solid var(--color-border, #ccc);
		border-radius: var(--radius-md, 6px);
		font: inherit;
		color: var(--color-text, inherit);
		background: var(--color-surface, #fff);
		cursor: pointer;
	}

	.welcome-dm-test-btn:hover:not(:disabled) {
		border-color: var(--color-gold, #b8860b);
	}

	.welcome-dm-test-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.welcome-dm-test-ok {
		color: var(--color-success, #2e7d32);
		font-size: 0.9em;
	}

	.welcome-dm-test-err {
		color: var(--color-danger, #c0392b);
		font-size: 0.9em;
	}
</style>
