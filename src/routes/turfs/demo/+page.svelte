<script lang="ts">
	// Admin-only walkthrough of the volunteer turf-checkout flow.
	//
	// Purpose: show organizers what a volunteer will actually do to get a
	// MiniVAN turf code, while the VAN security review (Story 0) is still
	// outstanding. Everything here is fabricated and client-side — no VAN call,
	// no database write. Claiming a turf mutates a $state object and nothing
	// else, which is exactly what makes it safe to hand to anyone.

	import './demo.css';
	import { resolve } from '$app/paths';
	import { formatDistance, haversineMeters } from '$lib/van/geometry.js';
	import { statusLabel, type VolunteerStatus } from '$lib/van/turf-status.js';
	import TurfMap from './TurfMap.svelte';
	import type { DemoTurf } from './demo-turfs.js';

	const { data } = $props();

	/** Turfs claimed during this demo session, keyed by mapRouteId. Resets on
	 *  reload — the point is to rehearse the flow, not to persist anything. */
	let claimed = $state<Record<number, boolean>>({});
	let released = $state<Record<number, boolean>>({});
	let selectedId = $state<number | null>(null);
	/** Keyed by turf, not a single flag: a volunteer may hold more than one, and
	 *  a shared boolean flips "Copied" on every card at once. */
	let copied = $state<Record<number, boolean>>({});

	const CLAIM_TTL_HOURS = 48;

	function effectiveStatus(turf: DemoTurf): VolunteerStatus {
		if (claimed[turf.mapRouteId]) return 'held-by-you';
		if (released[turf.mapRouteId]) return 'available';
		return turf.status;
	}

	const turfs = $derived<DemoTurf[]>(
		(data.turfs ?? []).map((t: DemoTurf) => ({ ...t, status: effectiveStatus(t) })),
	);

	const distances = $derived.by(() => {
		const here = data.location;
		const out: Record<number, number> = {};
		if (!here) return out;
		for (const turf of turfs) out[turf.mapRouteId] = haversineMeters(here, turf.centre);
		return out;
	});

	// Available turf first, then by distance. A volunteer opening this page
	// wants the nearest thing they can actually take, not a tidy alphabetical
	// list with everything claimed at the top.
	const sortedTurfs = $derived(
		[...turfs].sort((a, b) => {
			const rank = (t: DemoTurf) =>
				t.status === 'held-by-you' ? 0 : t.status === 'available' ? 1 : 2;
			return rank(a) - rank(b) || (distances[a.mapRouteId] ?? 0) - (distances[b.mapRouteId] ?? 0);
		}),
	);

	const myTurfs = $derived(turfs.filter((t) => t.status === 'held-by-you'));
	const availableCount = $derived(turfs.filter((t) => t.status === 'available').length);

	/** From the map: always open, never close. Clicking a polygon you are
	 *  already looking at should not collapse the panel you clicked it for. */
	function select(mapRouteId: number) {
		selectedId = mapRouteId;
	}

	/** From the list: a row is an accordion header, so clicking the open one
	 *  shuts it. */
	function toggle(mapRouteId: number) {
		selectedId = selectedId === mapRouteId ? null : mapRouteId;
	}

	let listEl = $state<HTMLUListElement | null>(null);

	// Selecting on the map expands a row that may be scrolled out of the pane
	// (or, on a phone, below the fold). Without this the click looks like it did
	// nothing at all. `nearest` so a row already in view doesn't move.
	$effect(() => {
		if (selectedId === null || !listEl) return;
		listEl.querySelector('.turf-row.is-selected')?.scrollIntoView({
			block: 'nearest',
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
		});
	});

	function claim(turf: DemoTurf) {
		claimed[turf.mapRouteId] = true;
		delete released[turf.mapRouteId];
		selectedId = turf.mapRouteId;
	}

	function release(turf: DemoTurf) {
		delete claimed[turf.mapRouteId];
		released[turf.mapRouteId] = true;
		delete copied[turf.mapRouteId];
	}

	async function copyCode(mapRouteId: number, code: string) {
		try {
			await navigator.clipboard.writeText(code);
			copied[mapRouteId] = true;
			setTimeout(() => delete copied[mapRouteId], 2000);
		} catch {
			// Clipboard is permission-gated and blocked outright in some
			// browsers. The number is selectable text either way, so a failure
			// here costs the volunteer one manual copy, not the flow.
			delete copied[mapRouteId];
		}
	}

	function staleness(minutes: number): string {
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.round(minutes / 60);
		return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
	}
</script>

<main>
	<div class="demo-banner" role="note">
		<strong>Demonstration.</strong> Every turf, door count and list number on this page is invented, and
		nothing here touches VAN or the database. This exists to show what the volunteer flow will look like
		while the VAN security review is still in progress.
	</div>

	<!-- `chapter` and `location` are set together by the load function; testing
	     both keeps the map's non-null prop honest without a cast. -->
	{#if !data.chapter || !data.location}
		<!-- Step 1. No chapter, no turf data — the server sends an empty list
		     until one is picked. -->
		<section class="chapter-gate">
			<h2>Where are you canvassing today?</h2>
			<p class="gate-help">
				Pick the chapter you're heading out with. You'll see the turfs for that chapter only — you
				don't have to be a member of it.
			</p>
			<ul class="chapter-list">
				{#each data.chapters as chapter (chapter.chapterId)}
					<li>
						<a class="chapter-choice" href="{resolve('/turfs/demo')}?chapter={chapter.chapterId}">
							<span class="chapter-name">{chapter.name}</span>
							<span class="chapter-go" aria-hidden="true">→</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<div class="chapter-bar">
			<div>
				<span class="chapter-label">Canvassing in</span>
				<span class="chapter-current">{data.chapter.name}</span>
			</div>
			<div class="bar-actions">
				<!-- Server-side, not cosmetic: this changes what the load function
				     serialises, so the volunteer view genuinely has no holder names in
				     its payload. Check devtools if you don't believe it. -->
				<span class="view-switch" role="group" aria-label="Preview as">
					<a
						class="view-option"
						class:is-active={!data.asAdmin}
						href="{resolve('/turfs/demo')}?chapter={data.chapter.chapterId}">Volunteer</a
					>
					<a
						class="view-option"
						class:is-active={data.asAdmin}
						href="{resolve('/turfs/demo')}?chapter={data.chapter.chapterId}&view=admin">Organizer</a
					>
				</span>
				<a class="change-chapter" href={resolve('/turfs/demo')}>Change chapter</a>
			</div>
		</div>

		{#if myTurfs.length > 0}
			<section class="my-turfs" aria-label="Your turf">
				{#each myTurfs as turf (turf.mapRouteId)}
					<article class="code-card">
						<header>
							<h2>{turf.name}</h2>
							<!-- A claim made during the demo gets the full window; a turf that
							     arrived already held keeps whatever it has left. -->
							<span class="expiry"
								>Yours for {turf.expiresInHours ?? CLAIM_TTL_HOURS} more hours</span
							>
						</header>

						<p class="code-lede">Open MiniVAN and enter this list number:</p>
						<div class="code-row">
							<output class="turf-code">{turf.printedListNumber}</output>
							<button
								type="button"
								class="copy-btn"
								onclick={() => copyCode(turf.mapRouteId, turf.printedListNumber)}
							>
								{copied[turf.mapRouteId] ? 'Copied' : 'Copy'}
							</button>
						</div>

						<ol class="steps">
							<li>Open <strong>MiniVAN</strong> on your phone and sign in.</li>
							<li>Choose <strong>Enter List Number</strong> and type the number above.</li>
							<li>Knock the doors, then hit <strong>Sync</strong> before you close the app.</li>
						</ol>
						<p class="sync-warning">
							Your answers only reach VAN when you sync. If you skip it, the turf looks unwalked and
							someone else gets sent to the same doors.
						</p>

						<div class="card-actions">
							<button type="button" class="ghost-btn" onclick={() => release(turf)}>
								Give this turf back
							</button>
						</div>
					</article>
				{/each}
			</section>
		{/if}

		<div class="turf-layout">
			<div class="map-col">
				<TurfMap turfs={sortedTurfs} {selectedId} location={data.location} onselect={select} />
				<ul class="legend">
					<li><span class="swatch swatch-available"></span> Available</li>
					<li><span class="swatch swatch-mine"></span> Yours</li>
					<li><span class="swatch swatch-other"></span> Checked out</li>
					<li><span class="swatch swatch-me"></span> You</li>
				</ul>
			</div>

			<div class="list-col">
				<div class="list-head">
					<h2>{availableCount} turf{availableCount === 1 ? '' : 's'} available</h2>
					{#if turfs.length > 0}
						<span class="freshness">
							Door counts from VAN, {staleness(turfs[0].refreshedMinutesAgo)}
						</span>
					{/if}
				</div>

				<!-- The <li> is the row, not the button: an expanded row holds a
				     "Check out" button of its own, and a button cannot nest inside a
				     button. The wrapper carries the accent border and the selected
				     tint so both halves are visibly one row. -->
				<ul class="turf-list" bind:this={listEl}>
					{#each sortedTurfs as turf (turf.mapRouteId)}
						<li
							class="turf-row"
							class:is-selected={turf.mapRouteId === selectedId}
							class:is-mine={turf.status === 'held-by-you'}
							class:is-unavailable={turf.status === 'checked-out'}
						>
							<button
								type="button"
								class="turf-card"
								onclick={() => toggle(turf.mapRouteId)}
								aria-expanded={turf.mapRouteId === selectedId}
								aria-controls={turf.mapRouteId === selectedId
									? `turf-detail-${turf.mapRouteId}`
									: undefined}
							>
								<div class="card-top">
									<span class="turf-name">{turf.name}</span>
									<span class="badge badge-{turf.status}">{statusLabel(turf.status)}</span>
								</div>
								<!-- One meta line rather than three stacked ones: in a dense
								     pane the region is a qualifier on the row, not a heading of
								     its own. -->
								<div class="card-meta">
									<span class="doors">{turf.doorsRemaining} doors left</span>
									{#if distances[turf.mapRouteId] !== undefined}
										<span class="dot" aria-hidden="true">·</span>
										<span>{formatDistance(distances[turf.mapRouteId])} away</span>
									{/if}
									<span class="dot" aria-hidden="true">·</span>
									<span class="card-region">{turf.regionName}</span>
								</div>
								{#if turf.heldBy}
									<!-- Only ever populated for admins; the server nulls it for
									     everyone else, so this can't leak by template edit. -->
									<div class="card-note admin-only">
										Held by {turf.heldBy}{turf.expiresInHours
											? ` — frees up in ${turf.expiresInHours} h`
											: ' (assigned in VAN)'}
									</div>
								{/if}
							</button>

							{#if turf.mapRouteId === selectedId}
								<div class="row-detail" id="turf-detail-{turf.mapRouteId}">
									<dl class="detail-stats">
										<div>
											<dt>Doors left</dt>
											<dd>{turf.doorsRemaining}</dd>
										</div>
										<div>
											<dt>Doors in turf</dt>
											<dd>{turf.doorCount}</dd>
										</div>
										<div>
											<dt>People</dt>
											<dd>{turf.routeSize}</dd>
										</div>
									</dl>

									{#if turf.status === 'available'}
										<button type="button" class="claim-btn" onclick={() => claim(turf)}>
											Check out this turf
										</button>
										<p class="claim-note">
											You'll get a MiniVAN list number and {CLAIM_TTL_HOURS} hours to walk it. Nobody
											else can take it in the meantime.
										</p>
									{:else if turf.status === 'held-by-you'}
										<p class="claim-note">Your list number is at the top of the page.</p>
									{:else}
										<p class="claim-note">
											Someone's already walking this one. It's shown rather than hidden so the map
											doesn't look like it has a hole in it — check back later, or pick another turf
											nearby.
										</p>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<footer class="demo-footer">
		<p>
			<strong>What's real:</strong> the turf shapes are computed by the production
			<code>$lib/van/geometry</code> code from fake door coordinates, so the hulls behave exactly as they
			will with live data.
		</p>
		<p>
			<strong>What's missing:</strong> street tiles under the map, and every VAN call. See
			<code>specs/010-van-turf-checkout/plan.md</code>.
		</p>
	</footer>
</main>
