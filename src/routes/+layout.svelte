<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { CHART_BAND_STYLE } from '$lib/styles/chart-colors';

	let { data, children } = $props();

	const pageTitle = $derived<string>(page.data.pageTitle ?? 'A4M Helper Tools');
	const onPending = $derived(page.url.pathname.startsWith('/pending'));
</script>

<div class="theme-vars" style={CHART_BAND_STYLE}>
	<header class="app-header">
		<h1>{pageTitle}</h1>
		<div class="user-info">
			{#if data.isAdmin && !onPending}
				<a class="nav-link" href={resolve('/pending')}>Pending applicants</a>
			{/if}
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
	}
	.user-info {
		font-size: var(--font-size-base);
		color: rgba(251, 240, 228, 0.75);
		display: flex;
		align-items: center;
		gap: 14px;
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
	.nav-link {
		color: var(--color-header-text);
		text-decoration: none;
		border-bottom: 1px dashed rgba(251, 240, 228, 0.4);
		padding-bottom: 1px;
	}
	.nav-link:hover {
		border-bottom-color: rgba(251, 240, 228, 0.9);
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