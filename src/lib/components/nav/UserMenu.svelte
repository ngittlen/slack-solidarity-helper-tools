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
						<a href={resolve(item.href)}>{item.label}</a>
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
		border: 1px solid rgba(251, 240, 228, 0.4);
		border-radius: var(--radius-md, 6px);
		padding: 4px 8px;
		font: inherit;
		cursor: pointer;
		min-width: 32px;
		min-height: 28px;
	}

	:global(.user-menu-trigger:hover),
	:global(.user-menu-trigger[data-state='open']) {
		background: rgba(255, 255, 255, 0.1);
		border-color: rgba(251, 240, 228, 0.8);
	}

	:global(.user-menu-trigger:focus-visible) {
		outline: 2px solid var(--color-gold, #b8860b);
		outline-offset: 2px;
	}

	:global(.user-menu-content) {
		background: var(--color-header-bg, #2a2a2a);
		color: var(--color-header-text, #fbf0e4);
		border: 1px solid rgba(251, 240, 228, 0.2);
		border-radius: var(--radius-md, 6px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		padding: 4px;
		min-width: 180px;
		z-index: 50;
	}

	:global(.user-menu-item) {
		border-radius: var(--radius-sm, 4px);
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
		background: rgba(255, 255, 255, 0.08);
		outline: none;
	}

	:global(.user-menu-item[data-current='true'] > a) {
		font-weight: 600;
		color: var(--color-gold, #b8860b);
	}
</style>
