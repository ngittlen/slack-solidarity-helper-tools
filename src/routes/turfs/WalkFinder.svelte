<script lang="ts">
	// Mentor walks for everyone who isn't hosting them (specs/015-mentor-walks,
	// User Stories 3 and 6), at the top of the turf list: the "How did your
	// walk go?" question, the seats the viewer holds, and the walk cards for
	// the chapter on screen.
	//
	// Alerts are the header bell's (NotificationToggle), which `onalerts` opens.
	// Joining and leaving are the page's, as the map's markers share them.

	import PostWalkCheckin from '$lib/components/mentor-walks/PostWalkCheckin.svelte';
	import WalkCard from '$lib/components/mentor-walks/WalkCard.svelte';
	import WalkCards from '$lib/components/mentor-walks/WalkCards.svelte';
	import '$lib/components/mentor-walks/mentor-walks.css';
	import type { WalkFinderView } from '$lib/mentor-walks/types.js';
	import { postMentorAction } from './mentor-post.js';

	interface Props {
		finder: WalkFinderView;
		/** The chapter on screen; its walks are the cards. */
		chapter: { chapterId: number; name: string };
		pageQuery: string;
		location: { lat: number; lng: number } | null;
		/** Whether the cards are showing: not for a new person who hasn't said
		 *  Yes, unless a message linked them to a walk. */
		showCards: boolean;
		onjoin: (id: string) => Promise<unknown>;
		onleave: (id: string) => Promise<unknown>;
		/** Opens the header bell on the alert settings. */
		onalerts: () => void;
		/** From joining or leaving. */
		error: string | null;
	}

	let { finder, chapter, pageQuery, location, showCards, onjoin, onleave, onalerts, error }: Props =
		$props();

	let ownError = $state<string | null>(null);

	/** Seats held on walks the cards below don't already show. */
	const otherSeats = $derived(
		finder.mine.filter((w) => !(showCards && finder.cards.some((c) => c.id === w.id))),
	);
	/** An empty chapter says so only to someone who asked to see walks;
	 *  anyone else isn't shown a heading over nothing. */
	const cardsShown = $derived(showCards && (finder.cards.length > 0 || finder.state === 'cards'));
</script>

{#snippet alertsLink()}
	<p class="finder-link">
		<button type="button" class="mw-btn mw-btn-link" onclick={onalerts}>
			{finder.alerts
				? 'Your alerts for walks near you'
				: 'Tell me when a mentor plans a walk near me'}
		</button>
	</p>
{/snippet}

<div class="walk-finder">
	{#each finder.checkins as walk (walk.walkId)}
		<!-- Not reloaded on answering, so the thanks stays on screen. -->
		<PostWalkCheckin
			{walk}
			onanswer={async (answer) => {
				ownError = null;
				const result = await postMentorAction(
					'mentorAnswer',
					{ walkId: walk.walkId, answer },
					pageQuery,
					{ reload: false },
				);
				if (!result.ok) ownError = result.message;
				return result.ok;
			}}
		/>
	{/each}

	{#if otherSeats.length > 0}
		<section class="finder-mine" aria-labelledby="mw-mine-seats-heading">
			<h2 id="mw-mine-seats-heading">{otherSeats.length === 1 ? 'Your walk' : 'Your walks'}</h2>
			{#each otherSeats as walk (walk.id)}
				<WalkCard {walk} {onjoin} {onleave} />
			{/each}
		</section>
	{/if}

	{#if cardsShown}
		<WalkCards
			walks={finder.cards}
			chapterName={chapter.name}
			{location}
			{onjoin}
			{onleave}
			footer={alertsLink}
		/>
	{/if}

	{#if error ?? ownError}
		<p class="mw-error" role="alert">{error ?? ownError}</p>
	{/if}
</div>

<style>
	.walk-finder {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	/* Nothing to show: no gap left above the sort bar. */
	.walk-finder:not(:has(> *)) {
		display: none;
	}

	.finder-link {
		margin: 0;
		font-size: var(--font-size-sm);
	}

	.finder-mine {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.finder-mine h2 {
		margin: 0;
		font-size: var(--font-size-md);
	}
</style>
