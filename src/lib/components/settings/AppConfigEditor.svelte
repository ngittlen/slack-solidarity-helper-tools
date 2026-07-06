<script lang="ts">
	import { errMessage } from '$lib/err-message.js';
	import { reRank, DEFAULT_RANKING_ALPHA } from '$lib/growth-ranking.js';
	import type { LeaderboardPair, LeaderboardResult } from '$lib/server/weekly-growth-report';
	import SlackLeaderboard from '$lib/components/dashboard/SlackLeaderboard.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import AutocompletePicker from './AutocompletePicker.svelte';
	import type { PickerItem } from './picker-types.js';
	import { createFieldAutosave, type AutosaveStatus } from './use-field-autosave.svelte.js';

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
		/** Saved/live leaderboards with UNTRIMMED topChapters — the slider
		 *  preview re-ranks them client-side. */
		leaderboard: LeaderboardPair;
	}

	let {
		channels,
		trackingChannelId,
		growthReportChannelId,
		rankingAlpha,
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

	$effect(() => () => alphaSave.destroy());

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
</style>
