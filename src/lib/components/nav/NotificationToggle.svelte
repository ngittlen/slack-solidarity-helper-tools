<script lang="ts">
	// The header's bell: push notifications about the volunteer's turf
	// (src/lib/server/push.ts, van/holder-notices.ts), on or off for this
	// person on this device. A bell when they are on, a crossed-out bell when
	// they are off; the popover under it says what that means and switches it.
	//
	// Offered to anyone signed in, turf or not: one switch in one place, always
	// there, is simpler than one that comes and goes with a claim.
	//
	// Per person and per device. A browser has one subscription for the site,
	// shared by everyone who uses it, but each person turns notifications on
	// or off for themselves, and the browser only gets the notices of whoever
	// used the site on it last: loading this claims it (push-client.ts).
	// Turning them off unsubscribes the browser only when nobody else on it
	// wants them. Shows nothing at all when the server has no VAPID key, so an
	// install without push looks as it did, unless the page is /turfs with
	// mentor walks on it.
	//
	// Under the switch: alerts about mentor walks near a ZIP (specs/015-
	// mentor-walks, User Story 7), for anyone the feature is shown to. Read
	// once the bell knows it will show, so they're there on the first click,
	// and again on each opening, keeping what was read meanwhile so the
	// section doesn't pop in after the rest. /turfs opens it
	// on them through `bell` (bell.svelte.ts), and an alert's "Stop these
	// alerts" link (`?mentorAlerts=stop`) opens it asking just that.

	import { Popover } from 'bits-ui';
	import { onMount, untrack } from 'svelte';
	import { afterNavigate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import AlertOptIn from '$lib/components/mentor-walks/AlertOptIn.svelte';
	import type { AlertsView } from '$lib/mentor-walks/types.js';
	import { bell } from './bell.svelte.js';
	import { scrollBehavior } from '$lib/motion.js';
	import {
		claimPushDevice,
		currentPushSubscription,
		forgetPushClaim,
		madeWithKey,
		pushNeedsInstall,
		pushSupported,
		turnOnPush,
	} from '$lib/push-client.js';

	type Status =
		| 'loading'
		| 'hidden'
		| 'unsupported'
		| 'install'
		| 'denied'
		| 'off'
		| 'on'
		| 'turning-on'
		| 'turning-off';

	let status = $state<Status>('loading');
	let publicKey = $state<string | null>(null);
	/** Whether they signed in with Slack, so get Slack DMs. Null until the
	 *  server has said. */
	let viaSlack = $state<boolean | null>(null);
	let error = $state<string | null>(null);
	/** This person's walk alerts, read on load and on each opening;
	 *  `available` false when mentor walks are hidden from them. Null until
	 *  first read. */
	let walkAlerts = $state<{ available: boolean; alerts: AlertsView | null } | null>(null);
	let walkAlertsError = $state<string | null>(null);
	/** This browser's push address as of load or turning on: what Turn off
	 *  tells the server, even if the browser has since dropped it. */
	let knownEndpoint: string | null = null;
	/** The read under way, so opening while the first read is out doesn't
	 *  start another. */
	let walkAlertsRead: Promise<void> | null = null;
	/** Bumped by each save or turn-off, so a read that started before one
	 *  doesn't put back what it replaced. */
	let walkAlertsWrites = 0;

	async function load(): Promise<void> {
		try {
			const res = await fetch('/api/push');
			if (!res.ok) {
				status = 'hidden';
				return;
			}
			const body = (await res.json()) as { publicKey: string | null; viaSlack: boolean };
			publicKey = body.publicKey;
			viaSlack = body.viaSlack;
			if (!publicKey) {
				status = 'hidden';
				return;
			}
			if (pushNeedsInstall()) {
				status = 'install';
				return;
			}
			if (!pushSupported()) {
				status = 'unsupported';
				return;
			}
			if (Notification.permission === 'denied') {
				status = 'denied';
				return;
			}
			// The browser may be subscribed for someone else who uses it: claiming
			// it makes it this person's, and says whether they want notifications.
			// One made with a VAPID key since replaced is dead: shown as off, so
			// turning on again makes a new one.
			const existing = await currentPushSubscription();
			knownEndpoint = existing?.endpoint ?? null;
			const claimed = existing ? await claimPushDevice(existing) : null;
			status = existing && claimed?.enabled && madeWithKey(existing, publicKey) ? 'on' : 'off';
		} catch {
			status = 'hidden';
		}
	}

	async function turnOn(): Promise<void> {
		if (!publicKey) return;
		error = null;
		status = 'turning-on';
		try {
			const { permission, subscription } = await turnOnPush(publicKey);
			if (!subscription) {
				status = permission === 'denied' ? 'denied' : 'off';
				return;
			}
			knownEndpoint = subscription.endpoint;
			status = 'on';
		} catch {
			error = "Couldn't turn notifications on. Try again in a moment.";
			status = 'off';
		}
	}

	async function turnOff(): Promise<void> {
		error = null;
		status = 'turning-off';
		try {
			const registration = await navigator.serviceWorker.getRegistration();
			const subscription = (await registration?.pushManager.getSubscription()) ?? null;
			// The address the server knows this browser by, even if the browser
			// dropped its subscription since: otherwise the setting stays on there.
			const endpoint = subscription?.endpoint ?? knownEndpoint;
			if (endpoint) {
				forgetPushClaim();
				const res = await fetch('/api/push', {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ endpoint }),
				});
				if (!res.ok) throw new Error('turn off failed');
				const { othersEnabled } = (await res.json()) as { othersEnabled: boolean };
				// Someone else on this browser still wants theirs.
				if (subscription && !othersEnabled) await subscription.unsubscribe();
			}
			knownEndpoint = null;
			status = 'off';
		} catch {
			error = "Couldn't turn notifications off. Try again in a moment.";
			status = 'on';
		}
	}

	// Once, in the browser: what this device can do and has already said, and
	// claiming it for whoever is signed in (push-client.ts).
	onMount(() => {
		void load().then(() => {
			// Only where the bell shows: a page with no bell needs no read.
			if (pushShown || walksOnPage) void loadWalkAlerts();
		});
	});

	// An alert's "Stop these alerts" link: on arriving, and on following it
	// from a message on /turfs, which changes the page without reloading.
	// Not again while it stays in the address as they move around /turfs.
	afterNavigate(({ from, to }) => {
		const stop = (url: URL | undefined) => url?.searchParams.get('mentorAlerts') === 'stop';
		if (stop(to?.url) && !stop(from?.url)) {
			bell.walkAlerts = 'stop';
			bell.open = true;
		}
	});

	function loadWalkAlerts(): Promise<void> {
		walkAlertsRead ??= readWalkAlerts().finally(() => (walkAlertsRead = null));
		return walkAlertsRead;
	}

	async function readWalkAlerts(): Promise<void> {
		const writes = walkAlertsWrites;
		try {
			const res = await fetch('/api/mentor-walks/alerts');
			if (!res.ok) throw new Error('alerts read failed');
			const read = (await res.json()) as typeof walkAlerts;
			// Saved or stopped since this read went out: what it found is old.
			if (writes !== walkAlertsWrites) return;
			walkAlerts = read;
			walkAlertsError = null;
		} catch {
			// What was read before still stands; only say so when there's nothing.
			if (walkAlerts === null) {
				walkAlertsError = "Couldn't load your walk alerts. Try again in a moment.";
			}
		}
	}

	function onOpenChange(next: boolean): void {
		if (next) return;
		// What it was opened for is done with.
		bell.walkAlerts = null;
		bell.fromPrompt = false;
	}

	let trigger = $state<HTMLButtonElement | null>(null);

	// Read again on each opening, from the button or from the page, in case
	// they were changed elsewhere. What's on hand shows meanwhile.
	//
	// The popover hangs from the bell, so opened from a link far down the
	// turf list it would open out of sight: the page scrolls up to the bell
	// when it isn't already in view.
	$effect(() => {
		if (!bell.open) return;
		untrack(() => {
			void loadWalkAlerts();
			trigger?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
		});
	});

	async function saveWalkAlerts(subscription: AlertsView): Promise<string | null> {
		walkAlertsWrites++;
		try {
			const res = await fetch('/api/mentor-walks/alerts', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...subscription, fromPrompt: bell.fromPrompt }),
			});
			const body = (await res.json()) as { error?: string };
			if (!res.ok) return body.error ?? 'Something went wrong. Please try again.';
			walkAlerts = { available: true, alerts: subscription };
			bell.fromPrompt = false;
			// /turfs shows whether they're on, and the prompt they may have answered.
			await invalidateAll();
			return null;
		} catch {
			return 'Something went wrong. Please try again.';
		}
	}

	async function stopWalkAlerts(): Promise<boolean> {
		walkAlertsWrites++;
		try {
			const res = await fetch('/api/mentor-walks/alerts', { method: 'DELETE' });
			if (!res.ok) return false;
			walkAlerts = { available: true, alerts: null };
			await invalidateAll();
			return true;
		} catch {
			return false;
		}
	}

	const pushShown = $derived(status !== 'loading' && status !== 'hidden');
	/** On /turfs with mentor walks shown: the bell is their alerts' home even
	 *  where push isn't set up. */
	const walksOnPage = $derived(Boolean(page.data.walkFinder));

	const on = $derived(status === 'on' || status === 'turning-off');

	/** Walk alerts go out as a push to this person's devices, else as a Slack
	 *  DM for someone signed in with Slack (notifyHolder). Anyone else would
	 *  only find them on the turf page, so they need notifications on first. */
	const walkDelivery = $derived.by((): { delivery: string | null; unavailable: string | null } => {
		// Not knowing how they signed in, say nothing rather than guess.
		if (status === 'loading' || on || viaSlack === null) {
			return { delivery: null, unavailable: null };
		}
		const canTurnOn = status === 'off' || status === 'turning-on';
		if (viaSlack) {
			return {
				delivery: canTurnOn
					? "We'll send these as Slack messages, or as notifications here once you turn them on above."
					: "We'll send these as Slack messages.",
				unavailable: null,
			};
		}
		return {
			delivery: null,
			unavailable: canTurnOn
				? 'Turn on notifications above to get these.'
				: "These come as notifications, which this device can't get right now.",
		};
	});
	const label = $derived(on ? 'Notifications are on' : 'Notifications are off');
	const instead = $derived(
		viaSlack ? 'instead of Slack messages' : 'as well as the messages on the turf page',
	);
</script>

{#if pushShown || walksOnPage || bell.walkAlerts === 'stop'}
	<Popover.Root bind:open={bell.open} {onOpenChange}>
		<Popover.Trigger bind:ref={trigger} class="notify-toggle" aria-label={label} title={label}>
			<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
				<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2H4.4Z" />
				<path d="M10 21a2.2 2.2 0 0 0 4 0" />
				{#if !on}
					<path class="slash" d="M3.5 3.5l17 17" />
				{/if}
			</svg>
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content class="notify-popover" side="bottom" sideOffset={10} collisionPadding={16}>
				{#if !pushShown}
					<!-- No device switch here: just the walk alerts below. -->
				{:else if status === 'on' || status === 'turning-off'}
					<p class="notify-heading">Notifications are on for you on this device.</p>
					<p>You'll hear about turf you hold here {instead}.</p>
					<button
						type="button"
						class="notify-btn notify-btn-secondary"
						disabled={status === 'turning-off'}
						onclick={turnOff}
					>
						{status === 'turning-off' ? 'One moment…' : 'Turn off'}
					</button>
				{:else if status === 'off' || status === 'turning-on'}
					<p class="notify-heading">Notifications are off for you on this device.</p>
					<p>
						Turn them on to get notified when turf you hold is about to expire or ends, when it
						changes in VAN, and when VAN has your doors — {instead}.
					</p>
					<button
						type="button"
						class="notify-btn"
						disabled={status === 'turning-on'}
						onclick={turnOn}
					>
						{status === 'turning-on' ? 'One moment…' : 'Turn on'}
					</button>
				{:else if status === 'install'}
					<p class="notify-heading">Notifications are off.</p>
					<p>
						To get them on an iPhone or iPad, tap <strong>Share</strong>, then
						<strong>Add to Home Screen</strong>, and open this site from the new icon.
					</p>
				{:else if status === 'denied'}
					<p class="notify-heading">Notifications are blocked.</p>
					<p>
						They're blocked for this site in this browser, for everyone who uses it. To get them,
						allow notifications for it in the browser's settings, then reload this page.
					</p>
				{:else}
					<p class="notify-heading">Notifications are off.</p>
					<p>This browser can't show notifications from websites.</p>
				{/if}
				{#if error}
					<p class="notify-error" role="alert">{error}</p>
				{/if}
				{#if walkAlerts?.available}
					<div class={['notify-walks', pushShown && 'notify-walks-ruled']}>
						<AlertOptIn
							subscription={walkAlerts.alerts}
							stopping={bell.walkAlerts === 'stop'}
							startEditing={bell.walkAlerts === 'setup'}
							delivery={walkDelivery.delivery}
							unavailable={walkDelivery.unavailable}
							onsave={saveWalkAlerts}
							onoff={stopWalkAlerts}
						/>
					</div>
				{:else if walkAlertsError}
					<p class="notify-error" role="alert">{walkAlertsError}</p>
				{:else if walkAlerts === null && !pushShown}
					<p>One moment…</p>
				{:else if !pushShown}
					<p>Nothing to set up here.</p>
				{/if}
				<!-- Drawn pointing down, as bits-ui expects, and turned to point up
				     at the bell. Filled like the box and outlined on its two
				     slanted sides, so it reads as part of the box's border. -->
				<Popover.Arrow width={18} height={9}>
					<svg class="notify-arrow" width="18" height="9" viewBox="0 0 18 9" aria-hidden="true">
						<path class="arrow-fill" d="M0 0L9 9L18 0Z" />
						<path class="arrow-edge" d="M0 0L9 9L18 0" />
					</svg>
				</Popover.Arrow>
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
{/if}

<style>
	/* The button matches ThemeToggle beside it. */
	:global(.notify-toggle) {
		display: inline-grid;
		place-items: center;
		width: 30px;
		height: 30px;
		padding: 0;
		background: transparent;
		color: var(--color-header-text);
		border: 1px solid color-mix(in srgb, var(--color-header-text) 40%, transparent);
		border-radius: var(--radius-md);
		cursor: pointer;
		opacity: 0.85;
		transition:
			opacity 120ms ease,
			background-color 120ms ease;
	}

	:global(.notify-toggle:hover),
	:global(.notify-toggle:focus-visible),
	:global(.notify-toggle[data-state='open']) {
		opacity: 1;
		background: color-mix(in srgb, var(--color-header-text) 10%, transparent);
	}

	:global(.notify-toggle:focus-visible) {
		outline: 2px solid var(--color-header-text);
		outline-offset: 2px;
	}

	svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	/* Like Bootstrap's popover: a box under the button with a triangle
	   pointing up at it. Page colours, not the header's, so it reads as a
	   card laid over the page. */
	:global(.notify-popover) {
		width: max-content;
		max-width: min(22rem, calc(100vw - 32px));
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-popover);
		font-size: var(--font-size-sm);
		line-height: 1.5;
		z-index: 50;
	}

	p {
		margin: 0 0 var(--space-2);
	}

	.notify-heading {
		font-weight: 600;
	}

	/* Sized and weighted like the walk alerts' buttons below (.mw-btn), so the
	   popover's buttons all match. */
	.notify-btn {
		min-height: 44px;
		margin-top: var(--space-1);
		padding: var(--space-2) var(--space-4);
		background: var(--color-action);
		color: var(--color-action-text);
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}

	.notify-btn:hover:not(:disabled) {
		background: var(--color-action-hover);
	}

	.notify-btn-secondary {
		background: transparent;
		color: var(--color-text);
		border-color: var(--color-border);
		font-weight: 600;
	}

	.notify-btn-secondary:hover:not(:disabled) {
		background: var(--color-bg-hover);
	}

	.notify-btn:disabled {
		cursor: progress;
		opacity: 0.7;
	}

	.notify-btn:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 2px;
	}

	.notify-error {
		margin: var(--space-2) 0 0;
		padding-left: var(--space-2);
		border-left: 3px solid var(--color-warning);
	}

	/* Walk alerts, ruled off from the device's switch above them. */
	.notify-walks-ruled {
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	.notify-arrow {
		display: block;
		/* Over the box's top border, so the triangle and box are one outline. */
		margin-top: -1px;
	}

	.arrow-fill {
		fill: var(--color-surface);
		stroke: none;
	}

	.arrow-edge {
		fill: none;
		stroke: var(--color-border);
		stroke-width: 1;
		stroke-linecap: butt;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.notify-toggle) {
			transition: none;
		}
	}
</style>
