<script lang="ts">
	// Host or edit a mentor walk (specs/015-mentor-walks, User Story 2,
	// FR-007–FR-012).
	//
	// The meeting place is looked up before posting, and shown on a map with
	// the address the geocoder matched, for the mentor to check: it sometimes
	// takes a half-understood address to the wrong town. An address that
	// can't be found is refused, and the mentor is asked for another: a street
	// address or nearby cross streets. There's no placing the pin by hand.

	import './mentor-walks.css';
	import PlacePreview from './PlacePreview.svelte';
	import { DEFAULT_LOOK_FOR, LOOK_FOR_MAX_LENGTH } from '$lib/mentor-walks/rules.js';
	import type {
		ChapterOption,
		PlaceLocation,
		PlaceLookupResult,
		WalkDraft,
	} from '$lib/mentor-walks/types.js';

	interface Props {
		chapterName: string;
		/** Chapters the walk can be posted in. Omitted, the walk is in
		 *  `chapterName`'s chapter and no picker is shown. */
		chapters?: ChapterOption[];
		/** The chapter on screen, picked by default for a new walk. */
		defaultChapterId?: number | null;
		/** Editing an existing walk when set. */
		initial?: WalkDraft | null;
		/** Seats already taken; the count can't go below this (FR-009). */
		seatsTaken?: number;
		/** From the mentor's most recent walk that still has one (FR-012). */
		defaultPhone?: string;
		/** How they said to spot them last time, or campaign merch. */
		defaultLookFor?: string;
		/** Basemap for the place preview, as /turfs is given it. */
		tiles?: { urlTemplate: string; attribution: string };
		/** Finds the meeting place on the map. */
		onlocate: (place: string) => Promise<PlaceLookupResult>;
		/** Saves the walk. Resolves with what's wrong with it, if anything; the
		 *  parent closes the form on success. */
		onsave: (draft: WalkDraft) => string[] | void | Promise<string[] | void>;
		oncancel: () => void;
	}

	let {
		chapterName,
		chapters = [],
		defaultChapterId = null,
		initial = null,
		seatsTaken = 0,
		defaultPhone = '',
		defaultLookFor = DEFAULT_LOOK_FOR,
		tiles,
		onlocate,
		onsave,
		oncancel,
	}: Props = $props();

	// The form owns its fields once open; a new `initial` means a new form,
	// which the parent gets by keying this component.
	// svelte-ignore state_referenced_locally
	const start = initial;
	// svelte-ignore state_referenced_locally
	let chapterId = $state(start?.chapterId ?? defaultChapterId ?? chapters[0]?.chapterId);
	let date = $state(start?.date ?? '');
	let time = $state(start?.time ?? '');
	let place = $state(start?.place ?? '');
	let note = $state(start?.note ?? '');
	// svelte-ignore state_referenced_locally
	let lookFor = $state(start?.lookFor ?? defaultLookFor);
	// svelte-ignore state_referenced_locally
	let seats = $state(start?.seats ?? Math.max(2, seatsTaken));
	// svelte-ignore state_referenced_locally
	let phone = $state(start?.phone ?? defaultPhone);

	/** Where the place was found, and the text it was found for: editing the
	 *  place means looking it up again. An existing walk starts found. */
	let located = $state<PlaceLocation | null>(
		start?.point ? { point: start.point, matchedAddress: null } : null,
	);
	let locatedFor = $state(start?.point ? start.place.trim() : '');
	const placeChecked = $derived(located !== null && locatedFor === place.trim());

	let errors = $state<string[]>([]);
	let saving = $state(false);
	let locating = $state(false);

	const chapterLabel = $derived(
		chapters.find((c) => c.chapterId === chapterId)?.name ?? chapterName,
	);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const problems: string[] = [];
		if (chapters.length > 0 && chapterId === undefined) problems.push('Pick a chapter.');
		if (!date || !time) problems.push('Pick a date and start time.');
		if (!place.trim()) problems.push('Add a meeting place.');
		if (!lookFor.trim())
			problems.push('Say how new people will spot you, like “Campaign merch” or “Red cap”.');
		if (seats < 1 || seats > 6) problems.push('Open seats must be between 1 and 6.');
		if (seats < seatsTaken)
			problems.push(
				`${seatsTaken} ${seatsTaken === 1 ? 'person has' : 'people have'} already joined, so you need at least ${seatsTaken} seats.`,
			);
		errors = problems;
		if (problems.length > 0) return;
		// First press: show where the place is, and let them check it.
		if (!placeChecked || located === null) {
			await locate();
			return;
		}
		saving = true;
		try {
			errors =
				(await onsave({
					chapterId,
					date,
					time,
					place,
					point: located.point,
					note,
					lookFor,
					seats,
					phone,
				})) ?? [];
		} finally {
			saving = false;
		}
	}

	async function locate() {
		const query = place.trim();
		locating = true;
		try {
			const result = await onlocate(query);
			if (result.ok) {
				located = result.location;
				locatedFor = query;
			} else {
				located = null;
				errors = [result.message];
			}
		} finally {
			locating = false;
		}
	}
</script>

<section class="mw-panel" aria-labelledby="mw-form-heading">
	<h2 id="mw-form-heading">{initial ? 'Edit your walk' : 'Host a walk'}</h2>
	<p class="mw-muted">
		New canvassers in {chapterLabel} will see this among the next walks coming up.
	</p>

	<form class="mw-form" onsubmit={save} novalidate>
		{#if chapters.length > 1}
			<div class="mw-field">
				<label for="mw-chapter">Chapter</label>
				<select id="mw-chapter" bind:value={chapterId}>
					{#each chapters as chapter (chapter.chapterId)}
						<option value={chapter.chapterId}>{chapter.name}</option>
					{/each}
				</select>
			</div>
		{/if}

		<div class="mw-field-row">
			<div class="mw-field">
				<label for="mw-date">Date</label>
				<input id="mw-date" type="date" bind:value={date} required />
			</div>
			<div class="mw-field">
				<label for="mw-time">Start time</label>
				<input id="mw-time" type="time" bind:value={time} required />
			</div>
		</div>

		<div class="mw-field">
			<label for="mw-place">Meeting place</label>
			<input
				id="mw-place"
				type="text"
				bind:value={place}
				maxlength="200"
				placeholder="Library, coffee shop, park entrance, with the street address"
				autocomplete="off"
			/>
			<p class="mw-muted">
				Include the street address and town so it can go on the map, like "Ypsilanti District
				Library, 229 W Michigan Ave, Ypsilanti".
			</p>
			{#if located && placeChecked}
				<PlacePreview point={located.point} {tiles} label="Map of where {place.trim()} was found" />
				<p class="mw-muted" role="status">
					{#if located.matchedAddress}
						Found <strong>{located.matchedAddress}</strong>.
					{/if}
					Check the pin is in the right place. If it isn't, add the town or try nearby cross streets.
				</p>
			{/if}
		</div>

		<div class="mw-callout">
			<ul>
				<li><strong>Pick a public place</strong>, never a home address.</li>
				<li>
					<strong>Wear campaign merch</strong> if you have some, so new people can spot you.
				</li>
			</ul>
		</div>

		<div class="mw-field">
			<label for="mw-look-for">How will new people spot you?</label>
			<input
				id="mw-look-for"
				type="text"
				bind:value={lookFor}
				maxlength={LOOK_FOR_MAX_LENGTH}
				placeholder="Red cap and a clipboard"
				aria-describedby="mw-look-for-hint"
			/>
			<p id="mw-look-for-hint" class="mw-muted">
				Shown on your walk as “Look for: {lookFor.trim() || '…'}”.
			</p>
		</div>

		<div class="mw-field">
			<label for="mw-note">Note <span class="mw-muted">(optional)</span></label>
			<input
				id="mw-note"
				type="text"
				bind:value={note}
				maxlength="140"
				placeholder="By the front doors"
			/>
		</div>

		<div class="mw-field-row">
			<div class="mw-field">
				<label for="mw-seats">Open seats</label>
				<select id="mw-seats" bind:value={seats}>
					{#each [1, 2, 3, 4, 5, 6] as n (n)}
						<option value={n} disabled={n < seatsTaken}>{n}</option>
					{/each}
				</select>
			</div>
			<div class="mw-field">
				<label for="mw-phone">Phone for texts <span class="mw-muted">(optional)</span></label>
				<input id="mw-phone" type="tel" bind:value={phone} autocomplete="tel" />
			</div>
		</div>
		<p class="mw-muted">
			Only people who join can see your number, and it's deleted a day after the walk.
		</p>

		{#if errors.length > 0}
			<ul class="mw-error" role="alert">
				{#each errors as error (error)}
					<li>{error}</li>
				{/each}
			</ul>
		{/if}

		<div class="mw-actions">
			<button type="submit" class="mw-btn mw-btn-primary" disabled={saving || locating}>
				{#if locating}Finding it…{:else if !placeChecked}Find on map{:else if saving}Saving…{:else}{initial
						? 'Save changes'
						: 'Post walk'}{/if}
			</button>
			<button type="button" class="mw-btn mw-btn-ghost" onclick={oncancel}>Cancel</button>
		</div>
	</form>
</section>

<style>
	.mw-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	ul.mw-error {
		margin: 0;
		padding-left: 1.2em;
	}
</style>
