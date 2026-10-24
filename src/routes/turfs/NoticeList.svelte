<script lang="ts">
	// What a Google or Apple holder would have been DMed: an expiry warning, a
	// "did MiniVAN sync?" nudge, a re-cut, a mentor walk's news. Kept until
	// dismissed — the server drops them after a week regardless. Rendered from
	// plain segments ($lib/van/notice-text.ts), never as HTML.

	import { enhance } from '$app/forms';
	import type { TurfNoticeView } from './+page.server.js';

	interface Props {
		notices: TurfNoticeView[];
		/** `?/dismissNotice` plus the page's own query. */
		action: string;
		label: string;
	}

	let { notices, action, label }: Props = $props();
</script>

<ul class="turf-notices" aria-label={label}>
	{#each notices as notice (notice.id)}
		<li class="turf-notice">
			<div class="turf-notice-body">
				{#each notice.lines as line, i (i)}
					{#if line.length === 0}
						<span class="turf-notice-break"></span>
					{:else}
						<p>
							{#each line as segment, j (j)}
								{#if segment.href}
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a same-site path, checked server-side -->
									<a href={segment.href}>{segment.text}</a>
								{:else if segment.bold}
									<strong>{segment.text}</strong>
								{:else}
									{segment.text}
								{/if}
							{/each}
						</p>
					{/if}
				{/each}
			</div>
			<form method="POST" {action} use:enhance>
				<input type="hidden" name="id" value={notice.id} />
				<button type="submit" class="notice-dismiss">Dismiss</button>
			</form>
		</li>
	{/each}
</ul>

<style>
	.turf-notices {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.turf-notice {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-warning);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
	}

	.turf-notice-body p {
		margin: 0;
	}

	.turf-notice-break {
		display: block;
		height: var(--space-2);
	}

	.notice-dismiss {
		padding: 4px 10px;
		font: inherit;
		font-size: var(--font-size-sm);
		cursor: pointer;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
	}

	.notice-dismiss:hover {
		background: var(--color-bg-hover);
	}
</style>
