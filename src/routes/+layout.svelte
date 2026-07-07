<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { CHART_BAND_STYLE } from '$lib/styles/chart-colors';
	import UserMenu, { type MenuItem } from '$lib/components/nav/UserMenu.svelte';
	import HeaderCountdown from '$lib/components/nav/HeaderCountdown.svelte';

	let { data, children } = $props();

	const pageTitle = $derived<string>(page.data.pageTitle ?? 'A4M Helper Tools');

	const menuItems = $derived<MenuItem[]>(
		data.isAdmin
			? [
					{ href: '/pending', label: 'Pending applicants' },
					{ href: '/settings', label: 'Settings' },
				]
			: [],
	);
</script>

<div class="theme-vars" style={CHART_BAND_STYLE}>
	<header class="app-header">
		<h1>{pageTitle}</h1>
		{#if data.countdown}
			<HeaderCountdown label={data.countdown.label} endAt={data.countdown.endAt} />
		{/if}
		<div class="user-info">
			<UserMenu items={menuItems} />
			<span class="user-greeting">
				Logged in as <span class="user-name">{data.userName}</span>
			</span>
			<form method="POST" action="/auth/logout">
				<button type="submit" class="logout-btn">Log out</button>
			</form>
		</div>
	</header>

	{@render children?.()}
</div>

<style>
	.theme-vars {
		display: contents;
	}
	.app-header {
		background: var(--color-header-bg);
		padding: 16px 24px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.app-header h1 {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--color-header-text);
		margin: 0;
		/* h1 and .user-info flex equally so the countdown sits at the true
		   center of the bar regardless of how wide either side is. */
		flex: 1 1 0;
	}
	.user-info {
		font-size: var(--font-size-base);
		color: rgba(251, 240, 228, 0.75);
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 14px;
		flex: 1 1 0;
	}
	.user-greeting {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
	}
	.user-name {
		color: var(--color-gold);
		font-weight: 600;
	}
	.logout-btn {
		background: transparent;
		color: var(--color-header-text);
		border: 1px solid rgba(251, 240, 228, 0.4);
		border-radius: var(--radius-md);
		padding: 4px 10px;
		font-size: var(--font-size-sm);
		font-family: inherit;
		cursor: pointer;
	}
	.logout-btn:hover {
		background: rgba(255, 255, 255, 0.1);
		border-color: rgba(251, 240, 228, 0.8);
	}
</style>
