<script lang="ts">
	// Two pages at one URL: the volunteer turf checkout for a signed-in viewer,
	// and a teaser for everyone else. The load function decides which, and
	// ships only that branch's data — see +page.server.ts.

	import PublicTurfTeaser from '$lib/components/turfs/PublicTurfTeaser.svelte';
	import MemberTurfs from './MemberTurfs.svelte';
	import NamePrompt from './NamePrompt.svelte';
	import MentorPanel from './MentorPanel.svelte';
	import MentorDebug from './MentorDebug.svelte';
	import WalkFinder from './WalkFinder.svelte';
	import { openWalkAlerts } from '$lib/components/nav/bell.svelte.js';
	import NoticeList from './NoticeList.svelte';
	import WalkDrawer from './WalkDrawer.svelte';
	import NewPersonPrompt from '$lib/components/mentor-walks/NewPersonPrompt.svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { WalkFinderView } from '$lib/mentor-walks/types.js';
	import { postPageAction } from './post-action.js';

	const { data, form } = $props();

	// The "that page is for Slack members" line, once dismissed, stays gone
	// until the next navigation — so a later bounce from a Slack-only page
	// brings it back. Kit reuses this component across client-side navigations,
	// which is why it is reset here rather than left to a fresh mount.
	let noticeDismissed = $state(false);
	afterNavigate(() => {
		noticeDismissed = false;
		// Whatever was followed is what they want to see, not the drawer, nor
		// a walk picked out on the way.
		drawerOpen = false;
		selectedWalkId = null;
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

	/** The page's walk cards, or a fresher copy fetched since. A copy is kept
	 *  with the data it replaced, so new page data always wins. */
	let refreshed = $state<{ from: WalkFinderView | null; view: WalkFinderView | null } | null>(null);
	const pageFinder = $derived('walkFinder' in data ? (data.walkFinder ?? null) : null);
	const walkFinder = $derived(
		refreshed && refreshed.from === pageFinder ? refreshed.view : pageFinder,
	);

	/** The walks drawer, opened from the chapter bar's button: walk
	 *  messages, the mentor's own walks, and staff tools. Alerts are the
	 *  header bell's (NotificationToggle). */
	let drawerOpen = $state(false);

	/** A walk a message linked to (`?walk=12#walk-12`): its card is shown,
	 *  even for someone who said No thanks, as an alert's "Join on /turfs"
	 *  promises. */
	const hashWalkId = $derived(/^#walk-([\w-]+)$/.exec(page.url.hash)?.[1] ?? null);
	const linkedWalkId = $derived(page.url.searchParams.get('walk') ?? hashWalkId);

	/** Reload the page with `?walk=` naming this walk, so its load includes
	 *  the card, and every reload after keeps it. */
	function linkWalk(id: string): Promise<void> {
		const query = [...page.url.searchParams]
			.filter(([key]) => key !== 'walk')
			.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
			.concat(`walk=${encodeURIComponent(id)}`)
			.join('&');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() is here; the rule misses it in this file
		return goto(`${resolve('/turfs')}?${query}${page.url.hash}`, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
			// The address may already be this one, after a seat given up on a
			// linked walk; the load runs again regardless.
			invalidateAll: true,
		});
	}

	// A message that names its walk in the fragment alone: the server never
	// sees a fragment, so the page asks again with `?walk=`.
	$effect(() => {
		if (hashWalkId === null || page.url.searchParams.has('walk')) return;
		void linkWalk(hashWalkId);
	});
	const finderState = $derived(walkFinder?.state ?? null);
	/** The cards at the top of the turf list, and the pins on the map: for
	 *  anyone but a new person who hasn't said Yes, unless a message linked
	 *  them to a walk. */
	const showCards = $derived(
		finderState === 'cards' ||
			finderState === 'toggle' ||
			(walkFinder !== null && linkedWalkId !== null),
	);
	const showFinder = $derived(walkFinder !== null && !data.needsName);
	const showMentor = $derived(data.mentor !== null && !data.needsName);
	const notices = $derived(data.mode === 'member' ? data.notices : []);
	const turfNotices = $derived(notices.filter((n) => !n.walk));
	const walkNotices = $derived(notices.filter((n) => n.walk));
	const mentorDebug = $derived(data.mode === 'member' ? data.mentorDebug : null);
	const hasDrawer = $derived(
		(showFinder && finderState === 'declined') ||
			showMentor ||
			walkNotices.length > 0 ||
			mentorDebug !== null,
	);
	/** Shown as a dot on the button: something in the drawer is waiting on
	 *  them. */
	const waiting = $derived(
		walkNotices.length +
			(showMentor && data.mentor && 'checkins' in data.mentor ? data.mentor.checkins.length : 0) +
			(showMentor && data.mentor?.state === 'invite' ? 1 : 0),
	);
	const buttonLabel = $derived(
		waiting > 0 ? `Mentor walks, ${waiting} waiting for you` : 'Mentor walks',
	);

	// The browser looked for a linked card before it was drawn, so scroll to
	// it once it is: on the first render, or when the cards that bring it
	// arrive, as after an old link's reload with `?walk=`. Once per link.
	let scrolledTo: string | null = null;
	$effect(() => {
		if (linkedWalkId === null || !showCards || scrolledTo === linkedWalkId) return;
		if (!walkFinder?.cards.some((c) => c.id === linkedWalkId)) return;
		const card = document.getElementById(`walk-${linkedWalkId}`);
		if (!card) return;
		scrolledTo = linkedWalkId;
		card.scrollIntoView({ block: 'start' });
	});
	function promptAnswer(answer: 'yes' | 'snooze' | 'decline' | 'reopen') {
		walkError = null;
		void postPageAction('mentorPrompt', { answer }, pageQuery).then((result) => {
			if (!result.ok) walkError = result.message;
		});
	}

	const chapter = $derived('chapter' in data ? data.chapter : null);

	let walkError = $state<string | null>(null);

	/** The walk selected on the map, from its marker or its card. */
	let selectedWalkId = $state<string | null>(null);
	let memberTurfs = $state<MemberTurfs | null>(null);

	/** A card selects its walk and centres the map on it, every click, so
	 *  clicking the selected card again brings back a marker panned away. */
	function selectWalkFromCard(id: string) {
		selectedWalkId = id;
		memberTurfs?.centreOnWalk(id);
	}

	async function joinWalk(id: string): Promise<void> {
		walkError = null;
		const result = await postPageAction('mentorJoin', { walkId: id }, pageQuery);
		if (!result.ok) walkError = result.message;
	}

	/** Giving a seat up keeps the walk's card on screen, though past the
	 *  first few walks only the seat had it shown: the reload names it as
	 *  linked, unless the page already links another walk. */
	async function leaveWalk(id: string): Promise<void> {
		walkError = null;
		const keep = showCards && (linkedWalkId === null || linkedWalkId === id);
		const result = await postPageAction('mentorLeave', { walkId: id }, pageQuery, {
			reload: !keep,
		});
		if (!result.ok) walkError = result.message;
		else if (keep) await linkWalk(id);
	}

	/** Fetch the chapter's walks again: someone else may have joined, or a walk
	 *  been cancelled (User Story 8, scenario 3). With the walk a message
	 *  linked to, which the cards always include, as the page's load does. */
	async function refreshWalks(): Promise<void> {
		const chapterId = chapter?.chapterId;
		if (chapterId === undefined || document.visibilityState !== 'visible') return;
		const from = pageFinder;
		try {
			const walk = linkedWalkId === null ? '' : `&walk=${encodeURIComponent(linkedWalkId)}`;
			const res = await fetch(`/api/mentor-walks?chapter=${chapterId}${walk}`);
			if (!res.ok) return;
			const { finder } = (await res.json()) as { finder: WalkFinderView | null };
			if (pageFinder === from) refreshed = { from, view: finder };
		} catch {
			// The next refresh tries again.
		}
	}

	const REFRESH_MS = 2 * 60_000;
	/** Refreshed while there are walks on screen, so a cancelled walk's card
	 *  and marker go (User Story 8, scenario 3). Not for everyone on a
	 *  chapter with no walks. */
	const refreshing = $derived(showCards && (walkFinder?.cards.length ?? 0) > 0);
	$effect(() => {
		if (!refreshing) return;
		const timer = setInterval(refreshWalks, REFRESH_MS);
		return () => clearInterval(timer);
	});
</script>

<svelte:document onvisibilitychange={() => refreshing && void refreshWalks()} />

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
		{#if dismissError}
			<p class="turf-notice-error" role="alert">{dismissError}</p>
		{/if}
		{#if turfNotices.length > 0}
			<NoticeList notices={turfNotices} action={dismissAction} label="Messages for you" />
		{/if}
		{#if data.needsName}
			<NamePrompt action={setNameAction} {confirmName} error={nameError} />
		{:else if nameTaken}
			<!-- Saved from another tab first: that name stands (FR-011b). -->
			<p class="needs-slack" role="status">
				You'd already chosen a name in another tab, so you're <strong>{nameTaken}</strong>.
			</p>
		{/if}
	</div>
	<!-- Walk markers only alongside the cards they open: someone who still
	     has to give a name has no list, so no markers either. -->
	<MemberTurfs
		bind:this={memberTurfs}
		{data}
		mentorWalks={walkFinder && showCards && showFinder
			? {
					cards: walkFinder.cards,
					onjoin: joinWalk,
					onleave: leaveWalk,
					selectedId: selectedWalkId,
					onselect: (id) => (selectedWalkId = id),
				}
			: null}
		walksButton={hasDrawer ? walksButton : undefined}
		walksList={showFinder ? walksList : undefined}
	/>

	{#snippet walksList(mapShown: boolean)}
		{#if finderState === 'prompt'}
			<!-- A new person is asked once (FR-014). -->
			<NewPersonPrompt
				onyes={() => promptAnswer('yes')}
				onsnooze={() => promptAnswer('snooze')}
				ondecline={() => promptAnswer('decline')}
				onalerts={() => openWalkAlerts({ setup: true, fromPrompt: true })}
			/>
		{/if}
		{#if walkFinder && chapter}
			<WalkFinder
				finder={walkFinder}
				{chapter}
				{pageQuery}
				location={data.location}
				{showCards}
				onjoin={joinWalk}
				onleave={leaveWalk}
				onalerts={() => openWalkAlerts({ setup: !walkFinder?.alerts })}
				error={walkError}
				{selectedWalkId}
				onselectwalk={mapShown ? selectWalkFromCard : undefined}
			/>
		{/if}
	{/snippet}

	{#snippet walksButton()}
		<button
			type="button"
			class={['walks-btn', walkFinder?.cardsStartOpen && 'walks-btn-new']}
			aria-haspopup="dialog"
			aria-label={buttonLabel}
			onclick={() => (drawerOpen = true)}
		>
			<span aria-hidden="true">👟</span> Mentor walks
			{#if waiting > 0}
				<span class="walks-dot" aria-hidden="true"></span>
			{/if}
		</button>
	{/snippet}

	<!-- Kept while open even once it's emptied, say by dismissing its last
	     message: taken away open, it would come back open by itself. -->
	{#if hasDrawer || drawerOpen}
		<WalkDrawer open={drawerOpen} onclose={() => (drawerOpen = false)}>
			{#if !hasDrawer}
				<p class="mw-muted">Nothing here right now.</p>
			{/if}
			{#if dismissError && walkNotices.length > 0}
				<!-- Also here: the page's copy is behind the drawer. -->
				<p class="turf-notice-error" role="alert">{dismissError}</p>
			{/if}
			{#if walkNotices.length > 0}
				<NoticeList notices={walkNotices} action={dismissAction} label="Mentor walk messages" />
			{/if}
			{#if showMentor && data.mentor}
				<!-- specs/015-mentor-walks. Not alongside the name prompt: a walk would
				     carry the name they haven't given yet. -->
				<MentorPanel mentor={data.mentor} chapter={data.chapter} {pageQuery} tiles={data.tiles} />
			{/if}
			{#if showFinder && finderState === 'declined'}
				<p class="walks-reopen">
					<button type="button" class="mw-btn mw-btn-link" onclick={() => promptAnswer('reopen')}>
						Show me mentor walks
					</button>
					<span class="mw-muted">to go out with an experienced canvasser.</span>
				</p>
			{/if}
			{#if mentorDebug}
				<!-- Staff only. -->
				<MentorDebug debug={mentorDebug} {pageQuery} />
			{/if}
		</WalkDrawer>
	{/if}
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

	.page-column:has(> :global(*)) + :global(main) {
		margin-top: 0;
	}

	@media (max-width: 640px) {
		.page-column {
			margin-top: var(--space-3);
			padding: 0 var(--space-4);
		}
	}

	.turf-notice-error {
		margin: 0;
		color: var(--color-error);
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

	/* On the chapter bar's navy, like "Change chapter" beside it. */
	.walks-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 36px;
		padding: 4px 12px;
		font: inherit;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		border: 1px solid color-mix(in srgb, var(--color-header-text) 50%, transparent);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-header-text);
	}

	.walks-btn:hover {
		background: color-mix(in srgb, var(--color-header-text) 12%, transparent);
	}

	.walks-btn:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 2px;
	}

	/* Someone who has never checked out a turf: the walks are for them. */
	.walks-btn-new {
		border-color: var(--color-action);
		background: var(--color-action);
		color: var(--color-action-text);
	}

	.walks-btn-new:hover {
		background: var(--color-action-hover);
	}

	.walks-dot {
		position: absolute;
		top: -4px;
		right: -4px;
		width: 12px;
		height: 12px;
		border: 2px solid var(--color-navy-mid);
		border-radius: 50%;
		background: var(--color-warning);
	}

	.walks-reopen {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1);
		margin: 0;
		font-size: var(--font-size-sm);
	}

	/* Before a chapter is picked, under the chapter list on the page's own
	   background rather than the navy bar. */
	:global(.chapter-gate) .walks-btn {
		margin-top: var(--space-4);
	}

	:global(.chapter-gate) .walks-btn:not(.walks-btn-new) {
		border-color: var(--color-border);
		color: var(--color-text);
	}

	:global(.chapter-gate) .walks-dot {
		border-color: var(--color-bg);
	}
</style>
