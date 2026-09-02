<script lang="ts">
	// The two numbers that govern turf checkout: how long a claim lasts, and how
	// many a volunteer may hold at once.
	//
	// They are `app_config` fields like the ranking α and the ticker speed, and
	// use the same debounced autosave — but they live in their own section
	// rather than as App config rows, so an organizer setting turf up finds them
	// beside the chapter → folder mapping and the block list instead of between
	// the warning DM and a slider about LEDs.
	//
	// Both are number inputs rather than sliders. A slider is right for the
	// ranking α, where the value is a feel and the preview re-ranks as you drag;
	// these are durations an organizer has an exact figure in mind for ("give
	// them the weekend"), and dragging to land on 48 is worse than typing it.

	import SettingsRow from './SettingsRow.svelte';
	import { createFieldAutosave } from './use-field-autosave.svelte.js';
	import {
		DEFAULT_CLAIM_TTL_HOURS,
		DEFAULT_MAX_CONCURRENT_CLAIMS,
		MAX_CLAIM_TTL_HOURS,
		MAX_CONCURRENT_CLAIMS,
		MIN_CLAIM_TTL_HOURS,
		MIN_CONCURRENT_CLAIMS,
	} from '$lib/van/checkout.js';

	interface Props {
		ttlHours: number;
		maxConcurrentClaims: number;
	}

	let { ttlHours, maxConcurrentClaims }: Props = $props();

	async function postAppConfig(patch: Record<string, unknown>): Promise<void> {
		const res = await fetch('/api/settings/app-config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch),
		});
		const parsed = (await res.json().catch(() => ({}))) as { error?: string };
		if (!res.ok) throw new Error(parsed.error ?? `Save failed (HTTP ${res.status})`);
	}

	const ttlSave = createFieldAutosave<number>({
		initial: ttlHours,
		parse: (raw) => parseInt(raw, 10),
		save: (value) => postAppConfig({ vanTurfClaimTtlHours: value }),
	});

	const capSave = createFieldAutosave<number>({
		initial: maxConcurrentClaims,
		parse: (raw) => parseInt(raw, 10),
		save: (value) => postAppConfig({ vanTurfMaxConcurrentClaims: value }),
	});

	$effect(() => () => {
		ttlSave.destroy();
		capSave.destroy();
	});

	/** Hours read as days once they stop being a number of hours anyone counts.
	 *  48 is "2 days" to an organizer planning a weekend, not forty-eight. */
	function asDays(hours: number): string {
		if (!Number.isFinite(hours) || hours < 24) return '';
		const days = hours / 24;
		const rounded = Number.isInteger(days) ? String(days) : days.toFixed(1);
		return ` (${rounded} ${days === 1 ? 'day' : 'days'})`;
	}
</script>

<SettingsRow
	label="How long a claim lasts"
	status={ttlSave.status}
	error={ttlSave.error}
	onRetry={ttlSave.status === 'error' ? ttlSave.retry : undefined}
>
	<div class="turf-number">
		<input
			type="number"
			min={MIN_CLAIM_TTL_HOURS}
			max={MAX_CLAIM_TTL_HOURS}
			step="1"
			value={ttlSave.value}
			oninput={ttlSave.oninput}
			aria-label="Turf claim length in hours"
		/>
		<span class="turf-unit">hours{asDays(ttlSave.value)}</span>
	</div>
	<p class="app-config-note">
		A volunteer who neither walks their turf nor gives it back loses it after this long, and it
		returns to the pool. They get a reminder six hours before that happens. Default {DEFAULT_CLAIM_TTL_HOURS}
		hours — long enough to cover a weekend, so turf claimed on Friday evening is still theirs on Sunday.
		Between {MIN_CLAIM_TTL_HOURS} and {MAX_CLAIM_TTL_HOURS} hours.
	</p>
</SettingsRow>

<SettingsRow
	label="Turfs one volunteer may hold"
	status={capSave.status}
	error={capSave.error}
	onRetry={capSave.status === 'error' ? capSave.retry : undefined}
>
	<div class="turf-number">
		<input
			type="number"
			min={MIN_CONCURRENT_CLAIMS}
			max={MAX_CONCURRENT_CLAIMS}
			step="1"
			value={capSave.value}
			oninput={capSave.oninput}
			aria-label="Maximum turfs one volunteer may hold at once"
		/>
		<span class="turf-unit">at a time</span>
	</div>
	<p class="app-config-note">
		Stops one volunteer taking a neighbourhood nobody else can then walk. Someone at the limit is
		told to finish or give one back rather than being refused without a reason. Default {DEFAULT_MAX_CONCURRENT_CLAIMS}.
		Between {MIN_CONCURRENT_CLAIMS} and {MAX_CONCURRENT_CLAIMS}.
	</p>
</SettingsRow>

<style>
	.turf-number {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.turf-number input {
		width: 6rem;
		padding: var(--space-2) var(--space-3);
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.turf-number input:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 1px;
	}

	.turf-unit {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}
</style>
