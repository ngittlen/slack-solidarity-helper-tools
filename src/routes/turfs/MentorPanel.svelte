<script lang="ts">
	// The mentor area of /turfs (specs/015-mentor-walks, User Stories 1 and
	// 2): the invitation, the guidelines agreement, a mentor's walks, and
	// "Who showed up?" after one (User Story 6).
	//
	// The screens' components take callbacks. Here each callback posts to the
	// page's `mentor*` form action and reloads the page data, so what's shown
	// always comes from the server. /turfs needs JavaScript for its map anyway.

	import { invalidateAll } from '$app/navigation';
	import MentorCheckin from '$lib/components/mentor-walks/MentorCheckin.svelte';
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
	import { postPageAction, SOMETHING_WRONG, type Posted } from './post-action.js';

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
	/** A declined person who clicked "Become a mentor". Kept as the screen it
	 *  was set on, so it lapses when that changes: the panel stays mounted
	 *  across reloads of the page data. */
	let reopenedOn = $state<string | null>(null);
	const reopened = $derived(reopenedOn === mentor.state);
	/** Which walk the form is open for: 'new', a walk id, or closed. */
	let formFor = $state<string | null>(null);
	let formKey = $state(0);
	/** A mentor asked to agree again who tapped Host a walk ('new') or Edit (a
	 *  walk id): the agreement shows, and that form opens once they agree. */
	let agreeFor = $state<string | null>(null);

	const editing = $derived(
		'walks' in mentor && formFor !== null && formFor !== 'new'
			? (mentor.walks.find((w) => w.id === formFor) ?? null)
			: null,
	);

	/** The chapters on offer, plus the walk's own when editing one in a
	 *  chapter /turfs has stopped offering, so it can be kept. */
	const formChapters = $derived.by(() => {
		if (!('chapters' in mentor)) return [];
		const own = editing?.draft.chapterId;
		if (own === undefined || mentor.chapters.some((c) => c.chapterId === own)) {
			return mentor.chapters;
		}
		return [...mentor.chapters, { chapterId: own, name: editing?.chapterName ?? '' }];
	});

	/** Posts to a form action (post-action.ts). A failure's message shows
	 *  below the panel, unless `quiet`, when the caller shows it, or the walk
	 *  form's own problems list carries it. */
	async function post(
		action: string,
		fields: Record<string, string | string[]>,
		{ reload = true, quiet = false } = {},
	): Promise<Posted> {
		error = null;
		const result = await postPageAction(action, fields, pageQuery, { reload });
		if (!result.ok && !quiet && !('mentorProblems' in result.data)) error = result.message;
		return result;
	}

	async function saveAttendance(walkId: string, seatIds: string[]): Promise<boolean> {
		return (await post('mentorAttendance', { walkId, seatId: seatIds })).ok;
	}

	function openForm(id: string) {
		formFor = id;
		formKey += 1;
	}

	/** Host or Edit: straight to the form, or first to the agreement for a
	 *  mentor who must agree again (US2, scenario 7). */
	function startForm(id: string) {
		if (mentor.state === 'agree') agreeFor = id;
		else openForm(id);
	}

	async function agree() {
		// The link on screen: what they agreed to, even if it changed since.
		const result = await post('mentorAgree', { agree: 'on', url: mentor.guidelinesUrl });
		if (result.ok) {
			// Straight on to planning their first walk (US1, scenario 2), or to
			// the one they meant to post or edit.
			openForm(agreeFor ?? 'new');
			agreeFor = null;
			return;
		}
		// Most likely the link changed while they read: reload so the new one
		// shows, and keep the agreement open for it.
		agreeFor ??= 'new';
		await invalidateAll();
	}

	async function locate(place: string): Promise<PlaceLookupResult> {
		const result = await post('mentorLocate', { place }, { reload: false, quiet: true });
		const location = result.data.mentorLocated as PlaceLocation | undefined;
		if (result.ok && location) return { ok: true, location };
		return { ok: false, message: result.ok ? SOMETHING_WRONG : result.message };
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
			lookFor: draft.lookFor,
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

<div class="mentor-panel">
	<!-- The agreement screens are keyed on the link, so a new one starts
	     with the box unticked. -->
	{#if mentor.state === 'invite' || (mentor.state === 'declined' && reopened)}
		{#key mentor.guidelinesUrl}
			<MentorInvite
				guidelinesUrl={mentor.guidelinesUrl}
				onagree={agree}
				onsnooze={() => post('mentorInvite', { answer: 'snooze' })}
				ondecline={() =>
					mentor.state === 'declined'
						? (reopenedOn = null)
						: post('mentorInvite', { answer: 'decline' })}
			/>
		{/key}
	{:else if mentor.state === 'agree' && agreeFor !== null}
		{#key mentor.guidelinesUrl}
			<MentorInvite
				guidelinesUrl={mentor.guidelinesUrl}
				agreeOnly
				onagree={agree}
				oncancel={() => (agreeFor = null)}
			/>
		{/key}
	{:else if mentor.state === 'declined'}
		<p class="mentor-reopen">
			<button type="button" class="mw-btn mw-btn-link" onclick={() => (reopenedOn = mentor.state)}>
				Become a mentor
			</button>
			<span class="mw-muted">and help new canvassers get started.</span>
		</p>
	{:else if 'walks' in mentor}
		<!-- An active mentor, agreed or asked to agree again: their walks
		     stay in reach either way, and the server cancels for both. -->
		{#each mentor.checkins as walk (walk.walkId)}
			<MentorCheckin {walk} onsave={(seatIds) => saveAttendance(walk.walkId, seatIds)} />
		{/each}
		{#if formFor !== null && mentor.state === 'mentor'}
			{#key formKey}
				<WalkForm
					chapterName={chapter?.name ?? 'your chapter'}
					chapters={formChapters}
					defaultChapterId={chapter?.chapterId ?? null}
					initial={editing?.draft ?? null}
					seatsTaken={editing?.joined.length ?? 0}
					defaultPhone={mentor.defaultPhone}
					defaultLookFor={mentor.defaultLookFor}
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
				onhost={() => startForm('new')}
				onedit={(id) => startForm(id)}
				oncancel={(id) => post('mentorCancelWalk', { walkId: id })}
			/>
		{/if}
	{/if}
	{#if error}
		<p class="mw-error" role="alert">{error}</p>
	{/if}
</div>

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
