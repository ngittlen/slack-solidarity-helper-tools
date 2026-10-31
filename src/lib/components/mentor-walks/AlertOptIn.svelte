<script lang="ts">
	// Opt in to hear about mentor walks near you (specs/015-mentor-walks,
	// User Story 7, FR-027–FR-029), in the header bell's popover beside the
	// device's notification switch. Alerts stay on until turned off here or
	// from an alert.

	import Select from '$lib/components/ui/Select.svelte';
	import { onMount } from 'svelte';
	import './mentor-walks.css';
	import { ALERT_RADII, DEFAULT_ALERT_RADIUS, type AlertRadius } from '$lib/mentor-walks/rules.js';
	import type { AlertsView } from '$lib/mentor-walks/types.js';

	interface Props {
		subscription: AlertsView | null;
		/** Opened from an alert's "Stop these alerts": the button to stop
		 *  them is shown first and focused. */
		stopping?: boolean;
		/** Resolves with what's wrong, or null once saved. */
		onsave: (subscription: AlertsView) => Promise<string | null>;
		onoff: () => Promise<boolean>;
		/** Opened to set them up: straight to the form. */
		startEditing?: boolean;
		/** The form's Cancel, when the panel was opened just for it. */
		oncancel?: () => void;
		/** How the alerts will reach them, said under the heading. */
		delivery?: string | null;
		/** Why they can't be set up or changed yet, e.g. notifications are off
		 *  and there's no Slack to fall back on. Turning them off still works. */
		unavailable?: string | null;
	}

	let {
		subscription,
		stopping = false,
		onsave,
		onoff,
		startEditing = false,
		oncancel,
		delivery = null,
		unavailable = null,
	}: Props = $props();

	let editing = $state(false);
	let zip = $state('');
	let radius = $state<AlertRadius>(DEFAULT_ALERT_RADIUS);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let stopped = $state(false);
	/** The stop screen is answered once: by stopping, by keeping them, or by
	 *  setting them up again. Until the page is opened from the link again. */
	let stopAnswered = $state(false);
	const asking = $derived(stopping && !stopAnswered);
	onMount(() => {
		if (startEditing && !unavailable) open();
	});

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}

	function open() {
		zip = subscription?.zip ?? '';
		radius = subscription?.radius ?? DEFAULT_ALERT_RADIUS;
		error = null;
		editing = true;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (unavailable) return;
		if (!/^\d{5}$/.test(zip.trim())) {
			error = 'Enter a 5-digit ZIP code.';
			return;
		}
		busy = true;
		try {
			error = await onsave({ zip: zip.trim(), radius });
			if (error !== null) return;
			editing = false;
			stopped = false;
			stopAnswered = true;
		} finally {
			busy = false;
		}
	}

	async function stop() {
		busy = true;
		try {
			if (await onoff()) {
				stopped = true;
				stopAnswered = true;
			}
		} finally {
			busy = false;
		}
	}
</script>

<section class="mw-alerts" aria-labelledby="mw-alerts-heading">
	<h3 id="mw-alerts-heading">Mentor walks near you</h3>
	{#if unavailable}
		<p class="mw-alerts-note">{unavailable}</p>
	{:else if delivery}
		<p class="mw-alerts-note">{delivery}</p>
	{/if}

	{#if editing}
		<form class="mw-alert-form" onsubmit={save} novalidate>
			<div class="mw-field-row">
				<div class="mw-field">
					<label for="mw-zip">Your ZIP code</label>
					<!-- Focused on opening: the button that opened it is gone, and
					     focus would otherwise drop to the top of the page. -->
					<input
						id="mw-zip"
						inputmode="numeric"
						autocomplete="postal-code"
						maxlength="5"
						bind:value={zip}
						data-autofocus
						{@attach focusOnMount}
					/>
				</div>
				<div class="mw-field">
					<label for="mw-radius">How far will you go?</label>
					<Select
						id="mw-radius"
						items={ALERT_RADII.map((miles) => ({ value: String(miles), label: `${miles} miles` }))}
						bind:value={() => String(radius), (v) => (radius = Number(v) as AlertRadius)}
					/>
				</div>
			</div>
			{#if error}
				<p class="mw-error" role="alert">{error}</p>
			{/if}
			<div class="mw-actions">
				<button type="submit" class="mw-btn mw-btn-primary" disabled={busy || !!unavailable}>
					{busy ? 'Saving…' : 'Turn on alerts'}
				</button>
				<button
					type="button"
					class="mw-btn mw-btn-ghost"
					onclick={() => {
						editing = false;
						oncancel?.();
					}}
				>
					Cancel
				</button>
			</div>
		</form>
	{:else if subscription && !stopped}
		{#if asking}
			<p>Stop getting alerts about mentor walks near you?</p>
			<div class="mw-actions">
				<button
					type="button"
					class="mw-btn mw-btn-danger"
					disabled={busy}
					onclick={stop}
					data-autofocus
					{@attach focusOnMount}
				>
					Stop these alerts
				</button>
				<button type="button" class="mw-btn mw-btn-ghost" onclick={() => (stopAnswered = true)}>
					Keep them
				</button>
			</div>
		{:else}
			<p>
				On: walks within <strong>{subscription.radius} miles</strong> of
				<strong>{subscription.zip}</strong>. We'll send at most 2 a day.
			</p>
			<div class="mw-actions">
				<button type="button" class="mw-btn mw-btn-ghost" disabled={!!unavailable} onclick={open}>
					Change
				</button>
				<button type="button" class="mw-btn mw-btn-link" disabled={busy} onclick={stop}>
					Turn off alerts
				</button>
			</div>
		{/if}
	{:else}
		{#if stopped || (asking && !subscription)}
			<p role="status">Alerts are off.</p>
		{/if}
		<p>Tell me when a mentor plans a walk near me.</p>
		<div class="mw-actions">
			<button type="button" class="mw-btn mw-btn-ghost" disabled={!!unavailable} onclick={open}>
				Set up alerts
			</button>
		</div>
	{/if}
</section>

<style>
	/* Bare: the popover around it is the box. */
	.mw-alerts {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.mw-alerts h3 {
		margin: 0;
		font-size: inherit;
	}

	.mw-alerts p {
		margin: 0;
	}

	.mw-alerts-note {
		color: var(--color-text-muted);
	}

	.mw-alert-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
</style>
