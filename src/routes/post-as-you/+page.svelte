<script lang="ts">
	import { page } from '$app/state';

	let { data, form } = $props();

	// Set by the OAuth callback on the way back from Slack.
	const justEnabled = $derived(page.url.searchParams.get('enabled') === '1');
	const declined = $derived(page.url.searchParams.get('declined') === '1');
</script>

<div class="pay-page">
	<p class="pay-intro">
		The info commands post their message as the person who runs them, so it shows up under your
		name, without an app badge, and you can edit or delete it like any message of yours. Slack needs
		your permission for that before the commands will work for you.
	</p>

	{#if form?.error}
		<p class="pay-status pay-status-error" role="alert">{form.error}</p>
	{:else if form?.turnedOff}
		<p class="pay-status" role="status">
			{#if form.revoked}
				Turned off. Slack has revoked the permission.
			{:else}
				Turned off here, but Slack didn't confirm it revoked the permission. To be certain, remove
				this app from your authorized apps in Slack.
			{/if}
		</p>
	{/if}

	{#if data.enabled}
		<p class="pay-status pay-status-on" role="status">
			{justEnabled ? 'Done — the info commands' : 'The info commands'} can post as you.
		</p>
		<form method="POST" action="?/turnOff">
			<button type="submit" class="pay-btn">Turn off</button>
		</form>
		<p class="pay-note">
			Turning it off deletes it here and asks Slack to revoke it. The info commands will stop
			working for you until you turn it back on.
		</p>
		<p class="pay-note">
			If an info command says Slack rejected your permission — you removed the app in Slack, say —
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a server endpoint, not a page route -->
			<a href="/auth/slack/post-as-you" data-sveltekit-reload>grant it again</a>.
		</p>
	{:else}
		{#if declined && !form}
			<p class="pay-status" role="status">Nothing was changed — you cancelled on Slack's screen.</p>
		{/if}
		<p class="pay-status">The info commands can't post as you right now.</p>
		<!-- A plain link, not a form: it hands the browser to Slack. -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a server endpoint, not a page route -->
		<a class="pay-btn pay-btn-primary" href="/auth/slack/post-as-you" data-sveltekit-reload>
			Let the info commands post as me
		</a>
		<p class="pay-note">
			Slack will ask your permission to send messages as you. That's the only thing it gets, and
			nothing else in this app uses it.
		</p>
	{/if}
</div>

<style>
	.pay-page {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-3);
		max-width: 640px;
		margin: 0 auto;
		padding: var(--space-3);
	}

	.pay-intro,
	.pay-status,
	.pay-note {
		margin: 0;
	}

	.pay-intro,
	.pay-note {
		color: var(--color-text-muted);
	}

	.pay-note {
		font-size: var(--font-size-sm);
	}

	.pay-status {
		font-weight: 600;
	}

	.pay-status-on {
		color: var(--color-success);
	}

	.pay-status-error {
		color: var(--color-error);
	}

	.pay-btn {
		display: inline-block;
		padding: 6px 14px;
		font: inherit;
		cursor: pointer;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
		color: var(--color-text);
		text-decoration: none;
	}

	.pay-btn:hover {
		background: var(--color-bg-hover);
	}

	.pay-btn-primary {
		font-weight: 600;
	}
</style>
