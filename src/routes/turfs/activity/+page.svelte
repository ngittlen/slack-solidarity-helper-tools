<script lang="ts">
	import Select from '$lib/components/ui/Select.svelte';
	import './activity.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import HolderName from '$lib/components/turfs/HolderName.svelte';
	import LoadMore from '$lib/components/ui/LoadMore.svelte';
	import type { ActivityPage } from './activity-page.js';
	import {
		ACTIVITY_KINDS,
		activityLabel,
		groupByDay,
		PERIOD_OPTIONS,
	} from '$lib/van/turf-activity.js';

	const { data } = $props();

	/** Older pages fetched as the organizer scrolls, under the load they extend.
	 *  `data.now` is new on every load, so a stale `loadedFor` reads as nothing
	 *  fetched yet — a new filter starts from its own first page. Raw, because
	 *  events are never changed after they arrive: each page replaces the
	 *  object, and wrapping every event in a proxy would cost on each one. */
	let older = $state.raw<(ActivityPage & { loadedFor: string }) | null>(null);
	const extended = $derived(older?.loadedFor === data.now ? older : null);
	const events = $derived(extended ? [...data.events, ...extended.events] : data.events);
	const dayLabels = $derived(
		extended ? { ...data.dayLabels, ...extended.dayLabels } : data.dayLabels,
	);
	const hasMore = $derived(extended ? extended.hasMore : data.hasMore);
	/** The load whose older page failed to arrive, so a new filter does not
	 *  inherit the retry. */
	let failedFor = $state<string | null>(null);
	const loadFailed = $derived(failedFor === data.now);

	const days = $derived(groupByDay(events));

	/** Whether an older page is on its way. Scrolling and the retry link both
	 *  ask, and two fetches from one cursor would bring the same page twice. */
	let loading = false;

	/** The page of events older than the oldest one on screen. Dropped if the
	 *  filters changed while it was in flight, so a stale page never lands in
	 *  the new list. */
	async function loadOlder() {
		if (loading) return;
		loading = true;
		try {
			await fetchOlder();
		} finally {
			loading = false;
		}
	}

	async function fetchOlder() {
		const loadedFor = data.now;
		const oldest = events.at(-1);
		if (!oldest) return;
		const params = new URLSearchParams([
			...page.url.searchParams,
			['before', oldest.at],
			['after', oldest.id],
			['now', data.now],
		]);
		failedFor = null;
		let next: ActivityPage;
		try {
			const res = await fetch(`${resolve('/turfs/activity/more')}?${params}`);
			if (!res.ok) throw new Error(`status ${res.status}`);
			next = (await res.json()) as ActivityPage;
		} catch {
			if (data.now === loadedFor) failedFor = loadedFor;
			return;
		}
		if (data.now !== loadedFor) return;
		// The cursor never hands back an event already shown, so the page is
		// appended as it is. A page with nothing in it would be asked for again,
		// forever, so it ends the list whatever `hasMore` says.
		older = {
			loadedFor,
			events: [...(extended?.events ?? []), ...next.events],
			dayLabels: { ...extended?.dayLabels, ...next.dayLabels },
			hasMore: next.hasMore && next.events.length > 0,
		};
	}

	// Zero-count kinds are dropped rather than rendered as "0 expired" — a row of
	// zeroes reads as a problem, and the counts are a summary, not a schema.
	const summary = $derived(
		ACTIVITY_KINDS.filter((kind) => data.counts[kind] > 0).map((kind) => ({
			kind,
			label: activityLabel(kind),
			count: data.counts[kind],
		})),
	);

	const periodLabel = $derived(
		PERIOD_OPTIONS.find((o) => o.value === data.period)?.label ?? 'this period',
	);

	/** Submits the filters a moment after typing stops, so the search runs
	 *  without an Enter but not on every keystroke. */
	const SEARCH_DELAY_MS = 400;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function searchSoon(event: Event & { currentTarget: HTMLInputElement }) {
		const form = event.currentTarget.form;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => form?.requestSubmit(), SEARCH_DELAY_MS);
	}

	// No `ago()` here, and no clock of any kind: each event arrives with its own
	// `agoLabel` from the load function. This file used to compute it from
	// `Date.now()` during render, which stamped the server's clock into SSR and
	// the browser's into hydration — a mismatch on every row, and the very thing
	// the note at the top of +page.server.ts says this page avoids.
</script>

<main>
	<!-- One GET form for every filter, so changing one keeps the others. Two
	     separate forms, or a link per chapter, would silently drop whichever
	     filter was not being changed. Each select submits it on change, and the
	     search box on Enter or a pause in typing. Focus stays in the box across
	     the navigation, and the URL is replaced rather than pushed, so typing
	     does not leave a history entry per word. -->
	<form
		class="filters"
		method="GET"
		action={resolve('/turfs/activity')}
		data-sveltekit-keepfocus
		data-sveltekit-replacestate
	>
		<div class="filter filter-search">
			<label for="q">Search</label>
			<input
				id="q"
				name="q"
				type="search"
				class="search"
				placeholder="Turf, volunteer or chapter"
				autocomplete="off"
				value={data.search}
				oninput={searchSoon}
			/>
		</div>

		<div class="filter">
			<label for="chapter">Chapter</label>
			<Select
				id="chapter"
				name="chapter"
				items={[
					{ value: '', label: 'All chapters' },
					...data.chapters.map((chapter) => ({
						value: String(chapter.chapterId),
						label: chapter.name,
					})),
				]}
				value={data.chapter ? String(data.chapter.chapterId) : ''}
				submitOnChange
			/>
		</div>

		{#if data.campaigns.length > 1}
			<div class="filter">
				<label for="campaign">Campaign</label>
				<Select
					id="campaign"
					name="campaign"
					items={[
						{ value: '', label: 'All campaigns' },
						...data.campaigns.map((campaign) => ({
							value: String(campaign.id),
							label: campaign.name,
						})),
					]}
					value={data.campaign ? String(data.campaign.id) : ''}
					submitOnChange
				/>
			</div>
		{/if}

		<div class="filter">
			<label for="days">Period</label>
			<Select
				id="days"
				name="days"
				items={PERIOD_OPTIONS.map((option) => ({
					value: String(option.value),
					label: option.label,
				}))}
				value={String(data.period)}
				submitOnChange
			/>
		</div>
	</form>

	{#if summary.length > 0}
		<ul class="summary">
			{#each summary as item (item.kind)}
				<li class="summary-item">
					<span class="summary-count">{item.count.toLocaleString('en-US')}</span>
					<span class="summary-label">{item.label}</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#if events.length === 0}
		<!-- Two different nothings. With no VAN key the catalog is empty, which is
		     the state anyone actually hits today, and reading it as "a quiet week"
		     would send an organizer looking for volunteers instead of a key. -->
		{#if !data.anyTurf}
			<p class="empty">
				No turf has been loaded yet, so there is no activity to show. An organizer needs to cut turf
				in VAN and the catalog sync needs to pull it in.
			</p>
		{:else}
			<p class="empty">
				No turf activity in {periodLabel.toLowerCase()}{data.chapter
					? ` for ${data.chapter.name}`
					: ''}{data.campaign ? ` in ${data.campaign.name}` : ''}{data.search
					? ` matching “${data.search}”`
					: ''}. {data.search ? 'Try another search or a longer period.' : 'Try a longer period.'}
			</p>
		{/if}
	{:else}
		{#each days as day (day.dayKey)}
			<section class="day">
				<h2 class="day-heading">{dayLabels[day.dayKey] ?? day.dayKey}</h2>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th class="col-time">Time</th>
								<th class="col-what">What</th>
								<th>Turf</th>
								<th>Chapter</th>
								<th>Volunteer</th>
							</tr>
						</thead>
						<tbody>
							{#each day.events as event (event.id)}
								<tr>
									<td class="col-time">
										<span class="time">{event.timeLabel}</span>
										<span class="time-ago">{event.agoLabel}</span>
									</td>
									<td class="col-what">
										<span class="badge badge-{event.kind}">{activityLabel(event.kind)}</span>
										{#if event.kind === 'completed' && event.reportedPercent !== null}
											<span class="reported-percent">{event.reportedPercent}% done</span>
										{/if}
									</td>
									<td>
										<span class="turf-name">{event.turfName}</span>
										{#if event.regionName}
											<span class="turf-region">{event.regionName}</span>
										{/if}
										<span class="turf-doors">
											{event.doorCount.toLocaleString('en-US')} doors
											{#if event.kind === 'completed' && event.confirmedDoorDelta !== null}
												· {event.confirmedDoorDelta.toLocaleString('en-US')} cleared
											{/if}
										</span>
									</td>
									<td>
										{event.chapterName}
										{#if data.campaignBadges[event.campaignId]}
											<span class="turf-region">{data.campaignBadges[event.campaignId]}</span>
										{/if}
									</td>
									<td><HolderName name={event.slackUserName} account={event.account} /></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/each}

		{#if loadFailed}
			<p class="cap-note">
				Couldn't load older events.
				<button type="button" class="retry" onclick={loadOlder}>Try again</button>
			</p>
		{:else}
			<LoadMore onnear={loadOlder} disabled={!hasMore} />
		{/if}

		{#if hasMore}
			<!-- "N of M", never "M more": both halves then come from the same set,
			     so narrowing the period cannot make them disagree. -->
			<p class="cap-note">
				Showing the most recent {events.length.toLocaleString('en-US')} of
				{data.total.toLocaleString('en-US')} events.
			</p>
		{/if}
	{/if}
</main>
