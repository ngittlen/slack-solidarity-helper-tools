<script lang="ts" module>
	import type { RouteId } from '$app/types';

	export interface MenuItem {
		/** Route path the menu item navigates to. Typed as `RouteId` so a
		 *  typo'd or removed route is caught at compile time where items are
		 *  defined (and so `resolve()` accepts it). */
		href: RouteId;
		/** Visible label text. Sentence-case in this menu (intentional — page
		 *  titles are title-case; the source ticket distinguishes the two
		 *  contexts on purpose). */
		label: string;
	}
</script>

<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { isCurrentPath } from './menu-helpers.js';

	// `resolve`'s argument type distributes over a `RouteId` *union* into a union
	// of singleton tuples that a single call can't satisfy, even though it
	// accepts any RouteId at runtime. Re-type it once as a plain single-signature
	// function so the dynamic `item.href` below type-checks.
	const resolveRoute = resolve as (route: RouteId) => string;

	interface Props {
		items: MenuItem[];
	}

	let { items }: Props = $props();
</script>

{#if items.length > 0}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger class="user-menu-trigger" aria-label="Open menu">
			<svg
				viewBox="0 0 16 16"
				width="16"
				height="16"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				fill="none"
				aria-hidden="true"
			>
				<path d="M3 4h10M3 8h10M3 12h10" />
			</svg>
		</DropdownMenu.Trigger>
		<DropdownMenu.Portal>
			<DropdownMenu.Content class="user-menu-content" sideOffset={8} align="end">
				{#each items as item (item.href)}
					<DropdownMenu.Item
						class="user-menu-item"
						data-current={isCurrentPath(item.href, page.url.pathname) ? 'true' : undefined}
					>
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolveRoute is `resolve` re-typed; the rule can't see through the alias -->
						<a href={resolveRoute(item.href)}>{item.label}</a>
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Portal>
	</DropdownMenu.Root>
{/if}

<style>
	:global(.user-menu-trigger) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		color: var(--color-header-text);
		border: 1px solid color-mix(in srgb, var(--color-header-text) 40%, transparent);
		border-radius: var(--radius-md);
		padding: 4px 8px;
		font: inherit;
		cursor: pointer;
		min-width: 32px;
		min-height: 28px;
	}

	:global(.user-menu-trigger:hover),
	:global(.user-menu-trigger[data-state='open']) {
		background: color-mix(in srgb, var(--color-header-text) 10%, transparent);
		border-color: color-mix(in srgb, var(--color-header-text) 80%, transparent);
	}

	:global(.user-menu-trigger:focus-visible) {
		outline: 2px solid var(--color-gold);
		outline-offset: 2px;
	}

	:global(.user-menu-content) {
		background: var(--color-header-bg);
		color: var(--color-header-text);
		border: 1px solid color-mix(in srgb, var(--color-header-text) 20%, transparent);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-popover);
		padding: 4px;
		min-width: 180px;
		z-index: 50;
	}

	:global(.user-menu-item) {
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	:global(.user-menu-item > a) {
		display: block;
		padding: 6px 12px;
		color: inherit;
		text-decoration: none;
		font-size: var(--font-size-base);
	}

	:global(.user-menu-item[data-highlighted]) {
		background: color-mix(in srgb, var(--color-header-text) 8%, transparent);
		outline: none;
	}

	:global(.user-menu-item[data-current='true'] > a) {
		font-weight: 600;
		color: var(--color-gold);
	}
</style>
