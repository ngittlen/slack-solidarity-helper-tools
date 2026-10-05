<script lang="ts">
	import { asset, resolve } from '$app/paths';

	let { data } = $props();
</script>

<div class="signin-page">
	<!-- The agreement Google's consent screen points at (/terms), stated where
	     the choice is actually made. -->
	<p class="signin-note">
		By signing in you agree to the
		<a href="{resolve('/policies')}#terms">Terms of Use</a>
		and the <a href="{resolve('/policies')}#privacy">Privacy Policy</a>.
	</p>

	{#if data.cancelled}
		<p class="signin-status" role="status">
			You cancelled on Google's screen, so you're not signed in. Pick a way in below.
		</p>
	{/if}

	<div class="signin-option">
		<!-- Plain links, not forms: each hands the browser to the provider. -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a server endpoint, not a page route -->
		<a class="signin-btn" href={data.slackHref} data-sveltekit-reload>
			<!-- Decorative: the text already says which. Same file as the holder
			     marks on the admin pages (HolderName.svelte). -->
			<img class="signin-logo" src={asset('/icons/slack.svg')} alt="" width="18" height="18" />
			Sign in with Slack
		</a>
		<p class="signin-note">For members of our Slack, including organizers.</p>
	</div>

	<div class="signin-option">
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a server endpoint, not a page route -->
		<a class="signin-btn" href={data.googleHref} data-sveltekit-reload>
			<img class="signin-logo" src={asset('/icons/google.svg')} alt="" width="18" height="18" />
			Sign in with Google
		</a>
		<p class="signin-note">
			<strong>Turf checkout only.</strong> For volunteers who want to knock doors without joining Slack.
		</p>
	</div>
</div>

<style>
	.signin-page {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-4);
		max-width: 640px;
		margin: 0 auto;
		padding: var(--space-3);
	}

	.signin-option {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.signin-status,
	.signin-note {
		margin: 0;
	}

	.signin-status {
		font-weight: 600;
	}

	.signin-note {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.signin-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: 8px 16px;
		font: inherit;
		font-weight: 600;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
		color: var(--color-text);
		text-decoration: none;
	}

	.signin-logo {
		flex: none;
		width: 18px;
		height: 18px;
	}

	.signin-btn:hover {
		background: var(--color-bg-hover);
	}
</style>
