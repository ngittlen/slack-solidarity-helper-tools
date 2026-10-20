<script lang="ts">
	// Organizer oversight of mentor walks (specs/015-mentor-walks, User Story
	// 4). The components are wired to this page's form actions: each callback
	// posts, then reloads the page data.

	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import OrganizerMentors from '$lib/components/mentor-walks/OrganizerMentors.svelte';
	import OrganizerWalks from '$lib/components/mentor-walks/OrganizerWalks.svelte';
	import '$lib/components/mentor-walks/mentor-walks.css';

	const { data } = $props();

	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	async function post(action: string, fields: Record<string, string>) {
		error = null;
		notice = null;
		const body = new FormData();
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		try {
			const res = await fetch(`?/${action}`, {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' },
			});
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				const done = result.data ?? {};
				if (typeof done.mentorMade === 'string') notice = `${done.mentorMade} is now a mentor.`;
				if (typeof done.mentorRevoked === 'string') {
					const n = Number(done.walksCancelled ?? 0);
					notice = `${done.mentorRevoked} is no longer a mentor.${n > 0 ? ` ${n} upcoming ${n === 1 ? 'walk was' : 'walks were'} cancelled.` : ''}`;
				}
				await invalidateAll();
				return;
			}
			if (result.type === 'failure') {
				const failed = result.data ?? {};
				const message = failed.walkError ?? failed.mentorError;
				if (typeof message === 'string') {
					error = message;
					return;
				}
			}
		} catch {
			// Falls through to the generic message.
		}
		error = 'Something went wrong. Please try again.';
	}
</script>

<main class="mw-organizer">
	<header>
		<h1>Mentor walks</h1>
		<a href={resolve('/turfs/organizer')}>← Turf right now</a>
	</header>

	<p class="mw-muted">
		Mentor walks are set to <strong>{data.visibilityLabel}</strong>.
		{#if !data.guidelinesSet}
			Nobody can become a mentor until the volunteer guidelines link is set.
		{/if}
		Change both in <a href={resolve('/settings')}>Settings</a>, under Turf checkout.
	</p>

	{#if error}
		<p class="mw-error" role="alert">{error}</p>
	{:else if notice}
		<p class="mw-callout" role="status">{notice}</p>
	{/if}

	<OrganizerWalks
		upcoming={data.upcoming}
		past={data.past}
		onhide={(id) => post('hideWalk', { walkId: id })}
		oncancel={(id) => post('cancelWalk', { walkId: id })}
	/>

	{#if data.peopleError}
		<p class="mw-muted">{data.peopleError}</p>
	{/if}
	<OrganizerMentors
		mentors={data.mentors}
		candidates={data.candidates}
		onappoint={(id) => post('makeMentor', { holderId: id })}
		onrevoke={(id) => post('revokeMentor', { holderId: id })}
		onreinstate={(id) => post('reinstateMentor', { holderId: id })}
	/>
</main>

<style>
	.mw-organizer {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		max-width: 56rem;
		margin: 0 auto;
		padding: var(--space-4) var(--space-4) var(--space-6);
	}

	header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	h1 {
		margin: 0;
		font-size: var(--font-size-lg);
	}

	header a {
		font-size: var(--font-size-sm);
		color: var(--color-action);
	}

	.mw-organizer > p {
		margin: 0;
	}
</style>
