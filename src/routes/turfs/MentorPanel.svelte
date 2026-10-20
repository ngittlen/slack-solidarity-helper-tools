<script lang="ts">
	// The mentor area of /turfs (specs/015-mentor-walks, User Stories 1 and
	// 2): the invitation, the guidelines agreement, and a mentor's walks.
	//
	// The screens' components take callbacks. Here each callback posts to the
	// page's `mentor*` form action and reloads the page data, so what's shown
	// always comes from the server. /turfs needs JavaScript for its map anyway.

	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import MentorInvite from '$lib/components/mentor-walks/MentorInvite.svelte';
	import MyWalks from '$lib/components/mentor-walks/MyWalks.svelte';
	import WalkForm from '$lib/components/mentor-walks/WalkForm.svelte';
	import '$lib/components/mentor-walks/mentor-walks.css';
	import type {
		MentorPanelView,
		PlaceLocation,
		PlaceLookupResult,
		WalkDraft,
	} from '$lib/mentor-walks/types.js';

	interface Props {
		mentor: MentorPanelView;
		/** The chapter on screen, picked by default for a new walk. */
		chapter: { chapterId: number; name: string } | null;
		/** The page's own query, so a reload lands back on the same chapter. */
		pageQuery: string;
		/** Basemap for the meeting-place preview. */
		tiles?: { urlTemplate: string; attribution: string };
	}

	let { mentor, chapter, pageQuery, tiles }: Props = $props();

	let error = $state<string | null>(null);
	// Both of these are kept as the screen they were set on, so they lapse
	// when it changes: the panel stays mounted across reloads of the page
	// data, and "Not now" on one screen mustn't hide the next (after the
	// debug panel's "Start over", say).
	/** "Not now" on the agree-again screen closes it for this visit. */
	let dismissedOn = $state<string | null>(null);
	const dismissed = $derived(dismissedOn === mentor.state);
	/** A declined person who clicked "Become a mentor". */
	let reopenedOn = $state<string | null>(null);
	const reopened = $derived(reopenedOn === mentor.state);
	/** Which walk the form is open for: 'new', a walk id, or closed. */
	let formFor = $state<string | null>(null);
	let formKey = $state(0);

	const editing = $derived(
		mentor.state === 'mentor' && formFor !== null && formFor !== 'new'
			? (mentor.walks.find((w) => w.id === formFor) ?? null)
			: null,
	);

	/** The chapters on offer, plus the walk's own when editing one in a
	 *  chapter /turfs has stopped offering, so it can be kept. */
	const formChapters = $derived.by(() => {
		if (mentor.state !== 'mentor') return [];
		const own = editing?.draft.chapterId;
		if (own === undefined || mentor.chapters.some((c) => c.chapterId === own)) {
			return mentor.chapters;
		}
		return [...mentor.chapters, { chapterId: own, name: editing?.chapterName ?? '' }];
	});

	const SOMETHING_WRONG = 'Something went wrong. Please try again.';

	type Posted =
		{ ok: true; data: Record<string, unknown> } | { ok: false; data: Record<string, unknown> };

	/** Posts to a form action. On success the page data reloads, unless
	 *  `reload` is false; a failure's message shows below the panel, unless
	 *  `quiet`, when the caller shows it. */
	async function post(
		action: string,
		fields: Record<string, string>,
		{ reload = true, quiet = false } = {},
	): Promise<Posted> {
		error = null;
		const body = new FormData();
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		try {
			const res = await fetch(`?/${action}${pageQuery ? `&${pageQuery}` : ''}`, {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' },
			});
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				if (reload) await invalidateAll();
				return { ok: true, data: result.data ?? {} };
			}
			if (result.type === 'failure') {
				const data = result.data ?? {};
				if (typeof data.mentorError === 'string' && !quiet) error = data.mentorError;
				return { ok: false, data };
			}
		} catch {
			// Falls through to the generic message.
		}
		if (!quiet) error = SOMETHING_WRONG;
		return { ok: false, data: {} };
	}

	function openForm(id: string) {
		formFor = id;
		formKey += 1;
	}

	async function agree() {
		// The link on screen: what they agreed to, even if it changed since.
		const result = await post('mentorAgree', { agree: 'on', url: mentor.guidelinesUrl });
		// Straight on to planning their first walk (US1, scenario 2).
		if (result.ok) openForm('new');
	}

	async function locate(place: string): Promise<PlaceLookupResult> {
		const result = await post('mentorLocate', { place }, { reload: false, quiet: true });
		const location = result.data.mentorLocated as PlaceLocation | undefined;
		if (result.ok && location) return { ok: true, location };
		const message = result.data.mentorError;
		return { ok: false, message: typeof message === 'string' ? message : SOMETHING_WRONG };
	}

	async function saveWalk(draft: WalkDraft): Promise<string[]> {
		const result = await post('mentorSaveWalk', {
			walkId: formFor !== null && formFor !== 'new' ? formFor : '',
			chapterId: String(draft.chapterId ?? ''),
			date: draft.date,
			time: draft.time,
			place: draft.place,
			lat: draft.point ? String(draft.point.lat) : '',
			lng: draft.point ? String(draft.point.lng) : '',
			note: draft.note,
			seats: String(draft.seats),
			phone: draft.phone,
		});
		if (result.ok) {
			formFor = null;
			return [];
		}
		const problems = result.data.mentorProblems;
		return Array.isArray(problems) ? problems.map(String) : [];
	}
</script>

{#if !dismissed}
	<div class="mentor-panel">
		{#if mentor.state === 'invite' || (mentor.state === 'declined' && reopened)}
			<MentorInvite
				guidelinesUrl={mentor.guidelinesUrl}
				onagree={agree}
				onsnooze={() => post('mentorInvite', { answer: 'snooze' })}
				ondecline={() =>
					mentor.state === 'declined'
						? (reopenedOn = null)
						: post('mentorInvite', { answer: 'decline' })}
			/>
		{:else if mentor.state === 'agree'}
			<MentorInvite
				guidelinesUrl={mentor.guidelinesUrl}
				agreeOnly
				onagree={agree}
				oncancel={() => (dismissedOn = mentor.state)}
			/>
		{:else if mentor.state === 'declined'}
			<p class="mentor-reopen">
				<button
					type="button"
					class="mw-btn mw-btn-link"
					onclick={() => (reopenedOn = mentor.state)}
				>
					Become a mentor
				</button>
				<span class="mw-muted">and help new canvassers get started.</span>
			</p>
		{:else if mentor.state === 'mentor'}
			{#if formFor !== null}
				{#key formKey}
					<WalkForm
						chapterName={chapter?.name ?? 'your chapter'}
						chapters={formChapters}
						defaultChapterId={chapter?.chapterId ?? null}
						initial={editing?.draft ?? null}
						seatsTaken={editing?.joined.length ?? 0}
						defaultPhone={mentor.defaultPhone}
						{tiles}
						onlocate={locate}
						onsave={saveWalk}
						oncancel={() => (formFor = null)}
					/>
				{/key}
			{:else}
				<MyWalks
					walks={mentor.walks}
					walksHosted={mentor.walksHosted}
					newPeopleTakenOut={mentor.newPeopleTakenOut}
					onhost={() => openForm('new')}
					onedit={(id) => openForm(id)}
					oncancel={(id) => post('mentorCancelWalk', { walkId: id })}
				/>
			{/if}
		{/if}
		{#if error}
			<p class="mw-error" role="alert">{error}</p>
		{/if}
	</div>
{/if}

<style>
	.mentor-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.mentor-reopen {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1);
		margin: 0;
		font-size: var(--font-size-sm);
	}
</style>
