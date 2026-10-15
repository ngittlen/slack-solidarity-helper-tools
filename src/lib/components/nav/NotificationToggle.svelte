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
	// install without push looks as it did.

	import { Popover } from 'bits-ui';
	import { onMount } from 'svelte';
	import {
		claimPushDevice,
		currentPushSubscription,
		forgetPushClaim,
		madeWithKey,
		pushKeyBytes,
		tellServiceWorker,
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
	let viaSlack = $state(true);
	let error = $state<string | null>(null);
	let open = $state(false);
	/** This browser's push address as of load or turning on: what Turn off
	 *  tells the server, even if the browser has since dropped it. */
	let knownEndpoint: string | null = null;

	/** iPhone and iPad Safari allow push only to a site added to the Home
	 *  Screen and opened from there. */
	function needsInstall(): boolean {
		const ios =
			/iPhone|iPad|iPod/.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		const standalone =
			window.matchMedia('(display-mode: standalone)').matches ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true;
		return ios && !standalone;
	}

	function supported(): boolean {
		return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
	}

	async function enable(subscription: PushSubscription): Promise<boolean> {
		forgetPushClaim();
		const res = await fetch('/api/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'on', subscription: subscription.toJSON() }),
		});
		if (!res.ok) return false;
		const { recipient } = (await res.json()) as { recipient: string };
		await tellServiceWorker(recipient);
		return true;
	}

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
			if (needsInstall()) {
				status = 'install';
				return;
			}
			if (!supported()) {
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
			const permission = await Notification.requestPermission();
			if (permission !== 'granted') {
				status = permission === 'denied' ? 'denied' : 'off';
				return;
			}
			// The browser's existing subscription, if someone else on it already
			// has notifications on; a new one otherwise. One made with a VAPID
			// key since replaced can never be sent to, so it is replaced too;
			// anyone else on this browser then turns theirs on again.
			const registration = await navigator.serviceWorker.ready;
			let existing = await registration.pushManager.getSubscription();
			if (existing && !madeWithKey(existing, publicKey)) {
				await existing.unsubscribe();
				existing = null;
			}
			const subscription =
				existing ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: pushKeyBytes(publicKey),
				}));
			if (!(await enable(subscription))) {
				if (!existing) await subscription.unsubscribe().catch(() => {});
				throw new Error('save failed');
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
		void load();
	});

	const on = $derived(status === 'on' || status === 'turning-off');
	const label = $derived(on ? 'Notifications are on' : 'Notifications are off');
	const instead = $derived(
		viaSlack ? 'instead of Slack messages' : 'as well as the messages on the turf page',
	);
</script>

{#if status !== 'loading' && status !== 'hidden'}
	<Popover.Root bind:open>
		<Popover.Trigger class="notify-toggle" aria-label={label} title={label}>
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
				{#if status === 'on' || status === 'turning-off'}
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
		max-width: min(20rem, calc(100vw - 32px));
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

	.notify-btn {
		margin-top: var(--space-1);
		padding: var(--space-2) var(--space-4);
		background: var(--color-action);
		color: var(--color-action-text);
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.notify-btn:hover:not(:disabled) {
		background: var(--color-action-hover);
	}

	.notify-btn-secondary {
		background: transparent;
		color: var(--color-text);
		border-color: var(--color-border);
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
