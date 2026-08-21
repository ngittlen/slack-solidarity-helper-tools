<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import UserMenu, { type MenuItem } from '$lib/components/nav/UserMenu.svelte';

	let { data, children } = $props();

	const pageTitle = $derived<string>(page.data.pageTitle ?? 'A4M Helper Tools');

	// Back-to-dashboard arrow on every non-root page (/pending, /settings).
	const showBackLink = $derived(page.url.pathname !== '/');

	const menuItems = $derived<MenuItem[]>(
		data.isAdmin
			? [
					{ href: '/pending', label: 'Pending applicants' },
					{ href: '/members', label: 'Member lookup' },
					{ href: '/turfs/demo', label: 'Turf checkout (demo)' },
					{ href: '/settings', label: 'Settings' },
				]
			: [],
	);
</script>

<div class="app-shell">
	<header class="app-header">
		<div class="header-left">
			{#if showBackLink}
				<a class="back-link" href={resolve('/')} aria-label="Back to dashboard">
					<svg
						viewBox="0 0 24 24"
						width="20"
						height="20"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M15 18l-6-6 6-6" />
					</svg>
				</a>
			{/if}
			<h1>{pageTitle}</h1>
		</div>
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
	.app-shell {
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
	.header-left {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		padding: 4px;
		margin-left: -6px;
		border-radius: var(--radius-md);
		color: var(--color-header-text);
		opacity: 0.8;
	}
	.back-link:hover,
	.back-link:focus-visible {
		opacity: 1;
		background: color-mix(in srgb, var(--color-header-text) 10%, transparent);
	}
	.app-header h1 {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--color-header-text);
		margin: 0;
	}
	.user-info {
		font-size: var(--font-size-base);
		color: color-mix(in srgb, var(--color-header-text) 75%, transparent);
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
	.logout-btn {
		background: transparent;
		color: var(--color-header-text);
		border: 1px solid color-mix(in srgb, var(--color-header-text) 40%, transparent);
		border-radius: var(--radius-md);
		padding: 4px 10px;
		font-size: var(--font-size-sm);
		font-family: inherit;
		cursor: pointer;
	}
	.logout-btn:hover {
		background: color-mix(in srgb, var(--color-header-text) 10%, transparent);
		border-color: color-mix(in srgb, var(--color-header-text) 80%, transparent);
	}
</style>
