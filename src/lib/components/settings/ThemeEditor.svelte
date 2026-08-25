<script lang="ts">
	// Editing the design system.
	//
	// Every colour token with full hex entry, light and dark side by side on one
	// row. Showing both at once is the point: the pairs are a relationship, not
	// two independent settings, and most mistakes here are only visible when you
	// can see what a colour becomes in the other mode. Toggling to find that out
	// meant nobody ever did.
	//
	// Two things keep full hex entry from being a footgun:
	//
	//   1. A live preview built from the SAME resolver the page uses, so what an
	//      admin sees here is exactly what ships.
	//   2. Contrast warnings on every text-on-surface pair. Full hex entry means
	//      an unreadable site is one paste away — and the trap is not obvious
	//      colours, it is plausible on-brand ones. Light Blue on Deep Blue looks
	//      right as two swatches and is about 2:1 as text.
	//
	// Warnings warn, they do not block: brand fidelity sometimes wins, and an
	// admin who is told the ratio can make that call themselves.

	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import { BRAND, BRAND_KEYS, type BrandColorKey } from '$lib/styles/brand.js';
	import { TOKENS, type TokenGroup, type TokenKey } from '$lib/styles/tokens.js';
	import {
		contrastWarnings,
		isValidHex,
		OVERRIDABLE_KEYS,
		parseOverrides,
		resolveTheme,
		themeInlineStyle,
		WCAG_AA_NORMAL,
		type Mode,
		type ThemeConfig,
	} from '$lib/styles/theme-css.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	interface Props {
		/** Stored overrides as JSON, from app_config.theme_tokens. */
		initialTokens: string;
	}

	let { initialTokens }: Props = $props();

	function initial(): ThemeConfig {
		try {
			return parseOverrides(JSON.parse(initialTokens || '{}')).config;
		} catch {
			return { brand: {}, tokens: {} };
		}
	}

	const start = initial();
	let overrides = $state(start.tokens);
	let brand = $state(start.brand);
	/** Which mode the PREVIEW shows. Both are editable regardless. */
	let previewMode = $state<Mode>('light');
	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);

	const MODES = ['light', 'dark'] as const;

	const theme = $derived(resolveTheme({ brand, tokens: overrides }));
	const previewStyle = $derived(themeInlineStyle(theme, previewMode));
	// Both modes' warnings, since both are on screen. Each is tagged with its
	// mode so a dark-only failure isn't mistaken for a light one.
	const warnings = $derived(contrastWarnings(theme));
	const overriddenCount = $derived(Object.keys(overrides).length + Object.keys(brand).length);

	// The palette in force — token rows show what they RESOLVE to, so editing a
	// brand colour visibly moves every token derived from it.
	const palette = $derived(theme.palette);

	const GROUPS: { id: TokenGroup; label: string; note?: string }[] = [
		{ id: 'surface', label: 'Surfaces' },
		{ id: 'text', label: 'Text' },
		{ id: 'action', label: 'Actions' },
		{ id: 'status', label: 'Status' },
		{ id: 'accent', label: 'Brand accents' },
		{
			id: 'led',
			label: 'LED board',
			note: 'A simulation of a physical sign, not brand colour. These are tuned to look like diodes on a dark panel and do not follow light/dark mode — remapping them to brand navy and cream will break the effect.',
		},
	];

	function keysIn(group: TokenGroup): TokenKey[] {
		return OVERRIDABLE_KEYS.filter((k) => TOKENS[k].group === group);
	}

	function valueOf(key: TokenKey, mode: Mode): string {
		return theme[mode][key];
	}

	/** What a token would be with no override — its brand-derived default. */
	function defaultOf(key: TokenKey, mode: Mode): string {
		const raw = TOKENS[key][mode];
		return raw.startsWith('@') ? palette[raw.slice(1) as BrandColorKey] : raw;
	}

	function isOverridden(key: TokenKey, mode: Mode): boolean {
		return overrides[key]?.[mode] !== undefined;
	}

	function isOverriddenAnyMode(key: TokenKey): boolean {
		return MODES.some((m) => isOverridden(key, m));
	}

	/** The LED board simulates a physical sign, so it does not follow light and
	 *  dark — its two values are always equal. One picker writes both, rather
	 *  than offering a second control that only exists to be kept in sync. */
	function isModeIndependent(key: TokenKey): boolean {
		return TOKENS[key].group === 'led';
	}

	// --- Saving ------------------------------------------------------------
	// The blob is many inputs, not one, so this is a small debounced controller
	// rather than createFieldAutosave (which is driven by a single oninput).
	// Same contract though: 600 ms debounce, single-flight, no auto-retry.

	const DEBOUNCE_MS = 600;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inflight = false;
	let pending = false;

	async function flush(): Promise<void> {
		if (inflight) {
			pending = true;
			return;
		}
		inflight = true;
		status = 'saving';
		error = null;
		try {
			const res = await fetch('/api/settings/app-config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ themeTokens: JSON.stringify({ brand, tokens: overrides }) }),
			});
			if (!res.ok) {
				const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
			}
			status = 'saved';
			setTimeout(() => {
				if (status === 'saved') status = 'idle';
			}, 2000);
		} catch (e) {
			status = 'error';
			error = errMessage(e);
		} finally {
			inflight = false;
			if (pending) {
				pending = false;
				void flush();
			}
		}
	}

	function schedule(): void {
		status = 'pending';
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, DEBOUNCE_MS);
	}

	/** Apply a value to one or more modes, dropping any that land back on the
	 *  brand default so "what has been customised" stays honest. */
	function write(key: TokenKey, hex: string, modes: readonly Mode[]): void {
		if (!isValidHex(hex)) return;
		const next = hex.trim().toLowerCase();
		const entry = { ...(overrides[key] ?? {}) };
		for (const m of modes) {
			// Compare against the brand-DERIVED default, not the raw '@ref', so
			// typing a token back to whatever the palette currently says drops the
			// override and lets it follow the palette again.
			if (next === defaultOf(key, m)) delete entry[m];
			else entry[m] = next;
		}
		if (Object.keys(entry).length === 0) {
			const rest = { ...overrides };
			delete rest[key];
			overrides = rest;
		} else {
			overrides = { ...overrides, [key]: entry };
		}
		schedule();
	}

	function setToken(key: TokenKey, mode: Mode, hex: string): void {
		write(key, hex, isModeIndependent(key) ? MODES : [mode]);
	}

	/** Clears BOTH modes — the row's reset is for the row. */
	function resetToken(key: TokenKey): void {
		if (!(key in overrides)) return;
		const rest = { ...overrides };
		delete rest[key];
		overrides = rest;
		schedule();
	}

	function setBrand(key: BrandColorKey, hex: string): void {
		if (!isValidHex(hex)) return;
		const next = hex.trim().toLowerCase();
		const rest = { ...brand };
		if (next === BRAND[key].hex) delete rest[key];
		else rest[key] = next;
		brand = rest;
		schedule();
	}

	function resetBrand(key: BrandColorKey): void {
		if (!(key in brand)) return;
		const rest = { ...brand };
		delete rest[key];
		brand = rest;
		schedule();
	}

	function resetAll(): void {
		overrides = {};
		brand = {};
		schedule();
	}

	$effect(() => () => {
		if (timer !== null) clearTimeout(timer);
	});
</script>

<div class="theme-editor">
	<SettingsRow label="Theme" {status} {error} onRetry={status === 'error' ? flush : undefined}>
		<div class="mode-tabs" role="group" aria-label="Which theme to preview">
			<span class="mode-lead">Preview</span>
			{#each MODES as m (m)}
				<button
					type="button"
					class="mode-tab"
					class:is-active={previewMode === m}
					aria-pressed={previewMode === m}
					onclick={() => (previewMode = m)}
				>
					{m === 'light' ? 'Light' : 'Dark'}
				</button>
			{/each}
			<span class="mode-note">
				Visitors get whichever their device asks for. Both need to work — edit both below.
			</span>
		</div>

		<!-- Preview uses the same resolver as the live page, so it cannot drift
		     from what will actually ship. -->
		<div class="preview" style={previewStyle} aria-label="Preview">
			<div class="preview-header">Abdul for US</div>
			<div class="preview-body">
				<p class="preview-h">Turf checkout</p>
				<p class="preview-p">Body copy sits on the page background.</p>
				<div class="preview-card">
					<p class="preview-p">A card, lifted off the ground.</p>
					<div class="preview-actions">
						<button type="button" class="preview-btn">Check out</button>
						<span class="preview-chip preview-ok">Available</span>
						<span class="preview-chip preview-warn">Expiring</span>
						<span class="preview-chip preview-err">Failed</span>
					</div>
				</div>
			</div>
		</div>

		{#if warnings.length > 0}
			<div class="warnings" role="status">
				<strong>{warnings.length} pair{warnings.length === 1 ? '' : 's'} below WCAG AA</strong>
				<span> (needs {WCAG_AA_NORMAL}:1 for normal text)</span>
				<ul>
					{#each warnings as w (w.mode + w.pair[0] + w.pair[1])}
						<li>
							<span class="warn-mode">{w.mode}</span>
							{TOKENS[w.pair[0]].label} on {TOKENS[w.pair[1]].label} — {w.ratio}:1
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<section class="group">
			<h4>Brand palette</h4>
			<p class="group-note">
				The 13 colours from the brand guide. These are the source: most tokens below point at one of
				them, so changing a colour here moves everything derived from it at once. A token you have
				set by hand keeps its own value. FOR US Yellow is marked video-only in the guide and is not
				used anywhere in the app.
			</p>
			<ul class="token-list">
				<li class="token-head" aria-hidden="true">
					<span></span>
					<span class="col-head">All modes</span>
					<span></span>
				</li>
				{#each BRAND_KEYS as key (key)}
					<li class="token-row is-single" class:is-muted={BRAND[key].videoOnly}>
						<span class="token-label">
							{BRAND[key].name}
							{#if BRAND[key].videoOnly}<span class="token-note">Video use only</span>{/if}
						</span>
						<span class="mode-cell" class:is-overridden={key in brand}>
							<input
								class="token-color"
								type="color"
								aria-label={BRAND[key].name}
								value={palette[key]}
								oninput={(e) => setBrand(key, e.currentTarget.value)}
							/>
							<input
								class="token-hex"
								type="text"
								spellcheck="false"
								aria-label="{BRAND[key].name} hex"
								value={palette[key]}
								onchange={(e) => setBrand(key, e.currentTarget.value)}
							/>
						</span>
						<button
							type="button"
							class="token-reset"
							disabled={!(key in brand)}
							title="Reset to the guide's value"
							onclick={() => resetBrand(key)}
						>
							Reset
						</button>
					</li>
				{/each}
			</ul>
		</section>

		{#each GROUPS as group (group.id)}
			{@const keys = keysIn(group.id)}
			{#if keys.length > 0}
				<section class="group">
					<h4>{group.label}</h4>
					{#if group.note}<p class="group-note">{group.note}</p>{/if}
					<ul class="token-list">
						<li class="token-head" aria-hidden="true">
							<span></span>
							{#if group.id === 'led'}
								<span class="col-head">Both modes</span>
							{:else}
								<span class="col-head">Light</span>
								<span class="col-head">Dark</span>
							{/if}
							<span></span>
						</li>
						{#each keys as key (key)}
							{@const single = isModeIndependent(key)}
							<li class="token-row" class:is-single={single}>
								<span class="token-label">
									{TOKENS[key].label}
									{#if TOKENS[key].note}<span class="token-note">{TOKENS[key].note}</span>{/if}
								</span>

								{#each single ? (['light'] as const) : MODES as m (m)}
									<span class="mode-cell" class:is-overridden={isOverridden(key, m)}>
										<input
											id="tok-{key}-{m}"
											class="token-color"
											type="color"
											aria-label="{TOKENS[key].label}, {single ? 'both modes' : m}"
											value={valueOf(key, m)}
											oninput={(e) => setToken(key, m, e.currentTarget.value)}
										/>
										<input
											class="token-hex"
											type="text"
											spellcheck="false"
											aria-label="{TOKENS[key].label} {single ? 'both modes' : m} hex"
											value={valueOf(key, m)}
											onchange={(e) => setToken(key, m, e.currentTarget.value)}
										/>
									</span>
								{/each}

								<button
									type="button"
									class="token-reset"
									disabled={!isOverriddenAnyMode(key)}
									title="Reset this token to the brand default in both modes"
									onclick={() => resetToken(key)}
								>
									Reset
								</button>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/each}

		<div class="editor-footer">
			<button type="button" class="reset-all" disabled={overriddenCount === 0} onclick={resetAll}>
				Reset everything to brand defaults
			</button>
			<span class="override-count">
				{overriddenCount === 0
					? 'No customisations — showing brand defaults.'
					: `${overriddenCount} token${overriddenCount === 1 ? '' : 's'} customised.`}
			</span>
		</div>
	</SettingsRow>
</div>

<style>
	.theme-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.mode-tabs {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 14px;
		flex-wrap: wrap;
	}

	.mode-tab {
		padding: 5px 14px;
		font-family: inherit;
		font-size: var(--font-size-md);
		font-weight: 600;
		color: var(--color-text-muted);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		cursor: pointer;
	}

	.mode-tab.is-active {
		background: var(--color-action);
		color: var(--color-action-text);
		border-color: var(--color-action);
	}

	.mode-note {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.mode-lead {
		font-size: var(--font-size-sm);
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.warn-mode {
		display: inline-block;
		min-width: 3.2em;
		font-size: var(--font-size-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-faint);
	}

	/* --- Preview --- */

	.preview {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		margin-bottom: 14px;
		background: var(--color-bg);
		color: var(--color-text);
		font-family: var(--font-body);
	}

	.preview-header {
		background: var(--color-header-bg);
		color: var(--color-header-text);
		padding: 10px 14px;
		font-family: var(--font-display);
		text-transform: uppercase;
		letter-spacing: var(--tracking-headline);
		font-weight: 700;
	}

	.preview-body {
		padding: 14px;
	}

	.preview-h {
		font-family: var(--font-display);
		text-transform: uppercase;
		letter-spacing: var(--tracking-headline);
		font-weight: 700;
		font-size: 1.15rem;
		margin: 0 0 4px;
	}

	.preview-p {
		margin: 0;
		font-size: var(--font-size-md);
		color: var(--color-text-muted);
	}

	.preview-card {
		margin-top: 12px;
		padding: 12px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-card);
	}

	.preview-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		flex-wrap: wrap;
	}

	.preview-btn {
		padding: 6px 14px;
		background: var(--color-action);
		color: var(--color-action-text);
		border: none;
		border-radius: var(--radius-md);
		font-family: inherit;
		font-size: var(--font-size-sm);
		font-weight: 600;
	}

	.preview-chip {
		font-size: var(--font-size-xs);
		font-weight: 700;
		padding: 3px 8px;
		border-radius: 999px;
	}

	.preview-ok {
		background: color-mix(in srgb, var(--color-success) 18%, transparent);
		color: var(--color-success);
	}
	.preview-warn {
		background: color-mix(in srgb, var(--color-warning) 18%, transparent);
		color: var(--color-warning);
	}
	.preview-err {
		background: color-mix(in srgb, var(--color-error) 18%, transparent);
		color: var(--color-error);
	}

	/* --- Warnings --- */

	.warnings {
		margin-bottom: 14px;
		padding: 10px 12px;
		background: color-mix(in srgb, var(--color-warning) 10%, transparent);
		border-left: 3px solid var(--color-warning);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-sm);
	}

	.warnings ul {
		margin: 6px 0 0;
		padding-left: 18px;
	}

	/* --- Token rows --- */

	.group {
		margin-bottom: 18px;
	}

	.group h4 {
		margin: 0 0 4px;
		font-size: var(--font-size-lg);
	}

	.group-note {
		margin: 0 0 8px;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		line-height: 1.5;
		max-width: 62ch;
	}

	.token-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	/* label | light | dark | reset. The two mode cells are fixed-width and equal
	   so the swatches line up into readable columns down the group — which is
	   the whole reason for showing both at once. */
	.token-row,
	.token-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 148px 148px auto;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
	}

	.token-row.is-single,
	.token-head:has(+ .token-row.is-single) {
		grid-template-columns: minmax(0, 1fr) 148px auto;
	}

	.token-head {
		padding-bottom: 2px;
	}

	.col-head {
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-faint);
	}

	.mode-cell {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 4px;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
	}

	/* A customised value should be findable at a glance when scanning a long
	   group; the swatch alone doesn't say whether it's brand or hand-set. */
	.token-row.is-muted .token-label {
		color: var(--color-text-faint);
	}

	.mode-cell.is-overridden {
		border-color: var(--color-gold-dark);
		background: color-mix(in srgb, var(--color-gold) 12%, transparent);
	}

	.token-label {
		font-size: var(--font-size-md);
		display: flex;
		flex-direction: column;
	}

	.token-note {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
		line-height: 1.4;
	}

	.token-color {
		width: 40px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: none;
		cursor: pointer;
	}

	.token-hex {
		width: 100%;
		min-width: 0;
		padding: 4px 6px;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
	}

	.token-reset,
	.reset-all {
		padding: 4px 10px;
		font-family: inherit;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		background: transparent;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.token-reset:disabled,
	.reset-all:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.editor-footer {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--color-border-subtle);
	}

	.override-count {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	/* Narrow: the label takes its own line and the two modes sit under it, still
	   side by side — losing the comparison is worse than losing the width. */
	@media (max-width: 720px) {
		.token-row,
		.token-head {
			grid-template-columns: 1fr 1fr auto;
		}
		.token-row.is-single,
		.token-head:has(+ .token-row.is-single) {
			grid-template-columns: 1fr auto;
		}
		.token-label {
			grid-column: 1 / -1;
		}
		.token-head span:first-child {
			display: none;
		}
	}
</style>
