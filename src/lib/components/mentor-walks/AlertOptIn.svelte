<script lang="ts">
	// Opt in to hear about mentor walks near you (specs/015-mentor-walks,
	// User Story 7, FR-027–FR-029). Alerts stay on until turned off here or
	// from an alert.

	import { onMount } from 'svelte';
	import './mentor-walks.css';
	import { ALERT_RADII, DEFAULT_ALERT_RADIUS, type AlertRadius } from '$lib/mentor-walks/rules.js';
	import type { AlertsView } from '$lib/mentor-walks/types.js';
	import { pushOfferKey, turnOnPush } from '$lib/push-client.js';

	interface Props {
		subscription: AlertsView | null;
		/** Opened from an alert's "Stop these alerts": the button to stop
		 *  them is shown first and focused. */
		stopping?: boolean;
		/** Resolves with what's wrong, or null once saved. */
		onsave: (subscription: AlertsView) => Promise<string | null>;
		onoff: () => Promise<boolean>;
		/** Opened from the new-person prompt: straight to the form. */
		startEditing?: boolean;
		/** The form's Cancel, when the panel was opened just for it. */
		oncancel?: () => void;
	}

	let {
		subscription,
		stopping = false,
		onsave,
		onoff,
		startEditing = false,
		oncancel,
	}: Props = $props();

	let editing = $state(false);
	let zip = $state('');
	let radius = $state<AlertRadius>(DEFAULT_ALERT_RADIUS);
	let pushToo = $state(true);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let stopped = $state(false);
	/** The stop screen is answered once: by stopping, by keeping them, or by
	 *  setting them up again. Until the page is opened from the link again. */
	let stopAnswered = $state(false);
	const asking = $derived(stopping && !stopAnswered);
	/** Set when this browser could take notifications but doesn't yet. */
	let pushKey = $state<string | null>(null);

	onMount(() => {
		if (startEditing) open();
		void pushOfferKey().then((key) => (pushKey = key));
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
		if (!/^\d{5}$/.test(zip.trim())) {
			error = 'Enter a 5-digit ZIP code.';
			return;
		}
		busy = true;
		// Asked first, while still inside the tap: browsers only show the
		// permission prompt in direct answer to one. Best effort: alerts come
		// by Slack or on /turfs either way.
		const pushing =
			pushKey && pushToo
				? turnOnPush(pushKey)
						.then(({ subscription }) => {
							if (subscription) pushKey = null;
						})
						.catch(() => {})
				: null;
		try {
			error = await onsave({ zip: zip.trim(), radius });
			await pushing;
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

<section class="mw-panel" aria-labelledby="mw-alerts-heading">
	<h3 id="mw-alerts-heading">🔔 Alerts for walks near you</h3>

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
						{@attach focusOnMount}
					/>
				</div>
				<div class="mw-field">
					<label for="mw-radius">How far will you go?</label>
					<select id="mw-radius" bind:value={radius}>
						{#each ALERT_RADII as miles (miles)}
							<option value={miles}>{miles} miles</option>
						{/each}
					</select>
				</div>
			</div>
			{#if pushKey}
				<label class="mw-inline-check">
					<input type="checkbox" bind:checked={pushToo} />
					Also send notifications to this device
				</label>
			{/if}
			{#if error}
				<p class="mw-error" role="alert">{error}</p>
			{/if}
			<div class="mw-actions">
				<button type="submit" class="mw-btn mw-btn-primary" disabled={busy}>
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
				<button type="button" class="mw-btn mw-btn-ghost" onclick={open}>Change</button>
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
			<button type="button" class="mw-btn mw-btn-ghost" onclick={open}>Set up alerts</button>
		</div>
	{/if}
</section>

<style>
	.mw-alert-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.mw-inline-check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
