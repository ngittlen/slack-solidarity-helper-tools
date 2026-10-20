<script lang="ts">
	// Two pages at one URL: the volunteer turf checkout for a signed-in viewer,
	// and a teaser for everyone else. The load function decides which, and
	// ships only that branch's data — see +page.server.ts.

	import PublicTurfTeaser from '$lib/components/turfs/PublicTurfTeaser.svelte';
	import MemberTurfs from './MemberTurfs.svelte';
	import NamePrompt from './NamePrompt.svelte';
	import MentorPanel from './MentorPanel.svelte';
	import MentorDebug from './MentorDebug.svelte';
	import { enhance } from '$app/forms';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';

	const { data, form } = $props();

	// The "that page is for Slack members" line, once dismissed, stays gone
	// until the next navigation — so a later bounce from a Slack-only page
	// brings it back. Kit reuses this component across client-side navigations,
	// which is why it is reset here rather than left to a fresh mount.
	let noticeDismissed = $state(false);
	afterNavigate(() => {
		noticeDismissed = false;
	});

	// The dismiss form posts to `?/dismissNotice` plus the page's own query, so
	// without JavaScript the reload lands back on the same chapter rather than
	// on a bare /turfs. Kit reads the action from the `/`-prefixed key alone.
	// The same for the name prompt's `?/setName`.
	const pageQuery = $derived(
		[...page.url.searchParams]
			// Not `needsSlack` either: carrying it would bring back the line the
			// volunteer may already have dismissed.
			.filter(([key]) => !key.startsWith('/') && key !== 'needsSlack')
			.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
			.join('&'),
	);
	const dismissAction = $derived(`?/dismissNotice${pageQuery ? `&${pageQuery}` : ''}`);
	const setNameAction = $derived(`?/setName${pageQuery ? `&${pageQuery}` : ''}`);

	const dismissError = $derived(
		form && 'dismissError' in form ? (form.dismissError ?? null) : null,
	);
	const confirmName = $derived(form && 'confirmName' in form ? (form.confirmName ?? null) : null);
	const nameError = $derived(form && 'nameError' in form ? (form.nameError ?? null) : null);
	const nameTaken = $derived(form && 'nameTaken' in form ? (form.nameTaken ?? null) : null);
</script>

{#if data.mode === 'public'}
	<PublicTurfTeaser
		tiles={data.tiles}
		turfCentre={data.turfCentre}
		joinUrl={data.joinUrl}
		signInHref={data.signInHref}
		nearby={form && 'nearby' in form ? (form.nearby ?? null) : null}
		error={form && 'error' in form ? (form.error ?? null) : null}
	/>
{:else}
	<!-- Everything above the turf list, in the same column as it. -->
	<div class="page-column">
		{#if data.needsSlackHref && !noticeDismissed}
			<!-- A Google or Apple sign-in that tried a Slack-only page was sent here
			     instead (server/turf-only-access.ts). Say why, rather than leave them wondering
			     what happened to the link they followed. -->
			<p class="needs-slack" role="status">
				<span>
					That page is for Slack members.
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a server endpoint, not a page route -->
					<a href={data.needsSlackHref} data-sveltekit-reload>Sign in with Slack</a> to see it.
				</span>
				<button type="button" class="needs-slack-dismiss" onclick={() => (noticeDismissed = true)}>
					Dismiss
				</button>
			</p>
		{/if}
		{#if data.notices.length > 0}
			<!-- What a Google or Apple holder would have been DMed: an expiry warning, a
			     "did MiniVAN sync?" nudge, a re-cut. Kept until dismissed — the
			     server drops them after a week regardless. Rendered from plain
			     segments ($lib/van/notice-text.ts), never as HTML. -->
			{#if dismissError}
				<p class="turf-notice-error" role="alert">{dismissError}</p>
			{/if}
			<ul class="turf-notices" aria-label="Messages about your turf">
				{#each data.notices as notice (notice.id)}
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
						<form method="POST" action={dismissAction} use:enhance>
							<input type="hidden" name="id" value={notice.id} />
							<button type="submit" class="needs-slack-dismiss">Dismiss</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
		{#if data.needsName}
			<NamePrompt action={setNameAction} {confirmName} error={nameError} />
		{:else if nameTaken}
			<!-- Saved from another tab first: that name stands (FR-011b). -->
			<p class="needs-slack" role="status">
				You'd already chosen a name in another tab, so you're <strong>{nameTaken}</strong>.
			</p>
		{/if}
		{#if data.mentorDebug}
			<MentorDebug debug={data.mentorDebug} {pageQuery} />
		{/if}
		{#if data.mentor && !data.needsName}
			<!-- specs/015-mentor-walks. Not alongside the name prompt: a walk would
			     carry the name they haven't given yet. -->
			<MentorPanel mentor={data.mentor} chapter={data.chapter} {pageQuery} tiles={data.tiles} />
		{/if}
	</div>
	<MemberTurfs {data} />
{/if}

<style>
	.needs-slack {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
	}

	/* The same column as MemberTurfs' <main> (turf-page.css), so the notices
	   and panels line up with the chapter bar and turf list below them. */
	.page-column {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		max-width: 1200px;
		margin: var(--space-6) auto var(--space-4);
		padding: 0 var(--space-5);
	}

	/* Nothing to show: no gap either, and <main> keeps its own top margin. */
	.page-column:not(:has(> *)) {
		display: none;
	}

	.page-column:has(> *) + :global(main) {
		margin-top: 0;
	}

	@media (max-width: 640px) {
		.page-column {
			margin-top: var(--space-3);
			padding: 0 var(--space-4);
		}
	}

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

	.turf-notice-error {
		margin: 0;
		color: var(--color-error);
	}

	.turf-notice-body p {
		margin: 0;
	}

	.turf-notice-break {
		display: block;
		height: var(--space-2);
	}

	.needs-slack-dismiss {
		padding: 4px 10px;
		font: inherit;
		font-size: var(--font-size-sm);
		cursor: pointer;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text-muted);
	}

	.needs-slack-dismiss:hover {
		background: var(--color-bg-hover);
	}
</style>
