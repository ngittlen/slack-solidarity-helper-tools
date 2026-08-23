<script lang="ts">
	// Light/dark switch in the header.
	//
	// Three states, cycling system → light → dark. "System" is not decoration:
	// the emitted stylesheet follows prefers-color-scheme by default, and someone
	// whose OS switches on a schedule expects the app to move with it. A plain
	// two-way toggle would quietly take that away the first time it was tapped.
	//
	// The click does two things — sets `data-theme` on <html> for the current
	// page, and writes a cookie so the SERVER can stamp the same attribute on
	// the next request. That second half is what avoids a flash: no inline
	// script reading localStorage after first paint, because the markup already
	// arrives correct.

	import {
		nextThemeMode,
		themeToggleLabel,
		THEME_COOKIE,
		THEME_COOKIE_MAX_AGE,
		type ThemeMode,
	} from '$lib/theme-mode.js';

	interface Props {
		/** Server-resolved mode, so the first render matches the stamped <html>. */
		mode: ThemeMode;
	}

	let { mode }: Props = $props();

	let current = $state<ThemeMode>(mode);

	function apply(next: ThemeMode): void {
		current = next;

		// Same rule as themeAttribute: 'system' means NO attribute, so the media
		// query governs again. Setting data-theme="system" would match neither
		// block and strand the page on the light defaults.
		if (next === 'system') document.documentElement.removeAttribute('data-theme');
		else document.documentElement.setAttribute('data-theme', next);

		const secure = location.protocol === 'https:' ? '; Secure' : '';
		document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
	}
</script>

<button
	type="button"
	class="theme-toggle"
	aria-label={themeToggleLabel(current)}
	title={themeToggleLabel(current)}
	onclick={() => apply(nextThemeMode(current))}
>
	{#if current === 'light'}
		<!-- Sun -->
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<circle cx="12" cy="12" r="4.2" />
			<g class="rays">
				<path
					d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1"
				/>
			</g>
		</svg>
	{:else if current === 'dark'}
		<!-- Moon -->
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7Z" />
		</svg>
	{:else}
		<!-- Half-filled circle: following the device -->
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<circle cx="12" cy="12" r="8.4" />
			<path class="filled" d="M12 3.6a8.4 8.4 0 0 1 0 16.8Z" />
		</svg>
	{/if}
</button>

<style>
	.theme-toggle {
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

	.theme-toggle:hover,
	.theme-toggle:focus-visible {
		opacity: 1;
		background: color-mix(in srgb, var(--color-header-text) 10%, transparent);
	}

	.theme-toggle:focus-visible {
		outline: 2px solid var(--color-header-text);
		outline-offset: 2px;
	}

	/* Strokes for outlines, fill for the solid halves — one rule set covers all
	   three icons so they read at the same visual weight. */
	.theme-toggle svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}

	.theme-toggle svg .filled {
		fill: currentColor;
		stroke: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.theme-toggle {
			transition: none;
		}
	}
</style>
