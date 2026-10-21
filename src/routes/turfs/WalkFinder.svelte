<script lang="ts">
	// Mentor walks for everyone who isn't hosting them (specs/015-mentor-walks,
	// User Stories 3, 6 and 7): the new-person prompt, the "How did your walk
	// go?" question, the walk cards for the chapter on screen, the seats the
	// viewer holds, and nearby-walk alerts.
	//
	// A new person is asked once; once they say yes the cards just show. Anyone
	// else gets a "Mentor walks" toggle and is never asked (FR-017). Joining
	// and leaving are the page's, as the map's markers share them.

	import NewPersonPrompt from '$lib/components/mentor-walks/NewPersonPrompt.svelte';
	import PostWalkCheckin from '$lib/components/mentor-walks/PostWalkCheckin.svelte';
	import WalkCard from '$lib/components/mentor-walks/WalkCard.svelte';
	import WalkCards from '$lib/components/mentor-walks/WalkCards.svelte';
	import AlertOptIn from '$lib/components/mentor-walks/AlertOptIn.svelte';
	import '$lib/components/mentor-walks/mentor-walks.css';
	import type { AlertsView, WalkFinderView } from '$lib/mentor-walks/types.js';
	import { postMentorAction } from './mentor-post.js';

	interface Props {
		finder: WalkFinderView;
		/** The chapter on screen; its walks are the cards. */
		chapter: { chapterId: number; name: string } | null;
		pageQuery: string;
		location: { lat: number; lng: number } | null;
		/** Whether the cards are showing: always after a new person's yes, and
		 *  for anyone else while the toggle is open. */
		showCards: boolean;
		ontoggle: (open: boolean) => void;
		onjoin: (id: string) => Promise<unknown>;
		onleave: (id: string) => Promise<unknown>;
		/** Opened from an alert's "Stop these alerts". */
		stoppingAlerts: boolean;
		/** From joining or leaving. */
		error: string | null;
	}

	let {
		finder,
		chapter,
		pageQuery,
		location,
		showCards,
		ontoggle,
		onjoin,
		onleave,
		stoppingAlerts,
		error,
	}: Props = $props();

	let ownError = $state<string | null>(null);
	/** The new-person prompt's "Tell me when…" opened the alert form. */
	let alertsFromPrompt = $state(false);

	async function post(action: string, fields: Record<string, string>, reload = true) {
		ownError = null;
		const result = await postMentorAction(action, fields, pageQuery, { reload });
		if (!result.ok) ownError = result.message;
		return result;
	}

	/** Seats held on walks the cards below don't already show. */
	const otherSeats = $derived(
		finder.mine.filter((w) => !(showCards && finder.cards.some((c) => c.id === w.id))),
	);

	async function saveAlerts(subscription: AlertsView): Promise<string | null> {
		const result = await postMentorAction(
			'mentorAlertsSave',
			{ zip: subscription.zip, radius: String(subscription.radius) },
			pageQuery,
		);
		return result.ok ? null : result.message;
	}

	async function stopAlerts(): Promise<boolean> {
		return (await post('mentorAlertsOff', {})).ok;
	}
</script>

{#snippet alerts()}
	<AlertOptIn
		subscription={finder.alerts}
		stopping={stoppingAlerts}
		onsave={saveAlerts}
		onoff={stopAlerts}
	/>
{/snippet}

<div class="walk-finder">
	{#each finder.checkins as walk (walk.walkId)}
		<!-- Not reloaded on answering, so the thanks stays on screen. -->
		<PostWalkCheckin
			{walk}
			onanswer={async (answer) =>
				(await post('mentorAnswer', { walkId: walk.walkId, answer }, false)).ok}
		/>
	{/each}

	{#if finder.state === 'prompt' && alertsFromPrompt}
		<!-- Saving them answers the prompt yes too: they want walks. -->
		<AlertOptIn
			subscription={finder.alerts}
			startEditing
			onsave={async (subscription) => {
				const problem = await saveAlerts(subscription);
				if (problem === null) await post('mentorPrompt', { answer: 'yes' });
				return problem;
			}}
			onoff={stopAlerts}
			oncancel={() => (alertsFromPrompt = false)}
		/>
	{:else if finder.state === 'prompt'}
		<NewPersonPrompt
			onyes={() => post('mentorPrompt', { answer: 'yes' })}
			onsnooze={() => post('mentorPrompt', { answer: 'snooze' })}
			ondecline={() => post('mentorPrompt', { answer: 'decline' })}
			onalerts={() => (alertsFromPrompt = true)}
		/>
	{:else if finder.state === 'declined'}
		<p class="finder-link">
			<button
				type="button"
				class="mw-btn mw-btn-link"
				onclick={() => post('mentorPrompt', { answer: 'reopen' })}
			>
				Show me mentor walks
			</button>
			<span class="mw-muted">to go out with an experienced canvasser.</span>
		</p>
	{:else if finder.state === 'toggle'}
		<div>
			<button
				type="button"
				class="mw-btn mw-btn-ghost"
				aria-expanded={showCards}
				aria-controls="mw-finder-cards"
				onclick={() => ontoggle(!showCards)}
			>
				👟 Mentor walks {showCards ? '▴' : '▾'}
			</button>
		</div>
	{/if}

	{#if otherSeats.length > 0}
		<section class="finder-mine" aria-labelledby="mw-mine-seats-heading">
			<h2 id="mw-mine-seats-heading">{otherSeats.length === 1 ? 'Your walk' : 'Your walks'}</h2>
			{#each otherSeats as walk (walk.id)}
				<WalkCard {walk} {onjoin} {onleave} />
			{/each}
		</section>
	{/if}

	{#if showCards}
		<div id="mw-finder-cards">
			{#if chapter}
				<WalkCards
					walks={finder.cards}
					chapterName={chapter.name}
					{location}
					{onjoin}
					{onleave}
					footer={alerts}
				/>
			{:else}
				<p class="mw-muted">Pick a chapter below to see its mentor walks.</p>
				{@render alerts()}
			{/if}
		</div>
	{:else if stoppingAlerts}
		{@render alerts()}
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

	.finder-link {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1);
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
