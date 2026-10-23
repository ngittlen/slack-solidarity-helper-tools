<script lang="ts">
	import './organizer.css';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import HolderName from '$lib/components/turfs/HolderName.svelte';
	import { campaignSheetStamp } from '$lib/campaign-time.js';
	import { driftAdvice, driftLabel } from '$lib/van/turf-drift.js';
	import type { ActionData } from './$types';

	const { data, form } = $props();

	/** While the "Sync VAN now" press is in flight. The sync itself runs on in
	 *  the background long after; this only covers starting it. */
	let syncStarting = $state(false);

	/** The press as the last poll of sync-status saw it, ahead of the load's
	 *  copy until the next load. */
	let polled = $state<{ sync: typeof data.manualSync } | null>(null);
	const sync = $derived(polled ? polled.sync : data.manualSync);
	/** Apart from `sync`, a new object every poll, so the timer below is not
	 *  torn down and set up again on each one. */
	const syncRunning = $derived(sync?.running ?? false);
	/** perCampaign is only there when the campaigns differ or one failed. */
	const lastSyncFailed = $derived(data.lastVanSync.perCampaign?.some((c) => c.failed) ?? false);

	/** While a press runs, ask after it every few seconds; once it is through,
	 *  reload the board once so the turf it picked up is in the tables. */
	const POLL_MS = 5000;
	$effect(() => {
		if (!syncRunning) return;
		let stopped = false;
		const timer = setInterval(async () => {
			try {
				const res = await fetch(resolve('/turfs/organizer/sync-status'));
				if (!res.ok || stopped) return;
				const next = (await res.json()) as { sync: typeof data.manualSync };
				if (stopped) return;
				polled = next;
				if (!next.sync?.running) {
					await invalidateAll();
					polled = null;
				}
			} catch {
				// The next tick tries again.
			}
		}, POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	});

	/** Hidden turf whose "show again" is in flight, so its box cannot be
	 *  ticked back mid-request. */
	let unhiding = $state<Record<number, boolean>>({});
	/** Requested turf whose chapter change is in flight. */
	let placing = $state<Record<number, boolean>>({});

	/** While a turf history search is in flight. */
	let historyLoading = $state(false);

	type HistoryResult = Extract<NonNullable<ActionData>, { historyQuery: string }>;

	/** The last history search's answer, kept apart from `form`: every other
	 *  form on the page replaces `form`, and the results and the search box
	 *  must not go with it. `form` is the fallback with JavaScript off, where a
	 *  search is a full page load. */
	let searched = $state<HistoryResult | null>(null);
	const history = $derived(searched ?? (form && 'historyQuery' in form ? form : null));

	// No `ago()` here, and no clock of any kind: the "ago" labels arrive from the
	// load function as `claimedAgoLabel` / `completedAgoLabel`. This file used to
	// compute them from `Date.now()` during render, which stamped the server's
	// clock into SSR and the browser's into hydration — a mismatch on every row.
	// Anything time-relative on this page belongs in +page.server.ts, measured
	// against the single `now` it already uses for the queries.

	function hoursLabel(hours: number): string {
		if (hours <= 0) return 'due now';
		return hours === 1 ? '1 hour left' : `${hours} hours left`;
	}

	// Read inside "… in {scope}" sentences: "Washtenaw County", "all chapters",
	// or with a campaign picked, "all chapters (Partner)".
	const scope = $derived(
		(data.chapter?.name ?? 'all chapters') + (data.campaign ? ` (${data.campaign.name})` : ''),
	);

	/** " · <badge>" after a row's chapter, while its campaign shows a badge
	 *  (more than one campaign enabled, or this one disabled). */
	function campaignSuffix(campaignId: number): string {
		const badge = data.campaignBadges[campaignId];
		return badge ? ` · ${badge}` : '';
	}

	/** "A", "A and B", "A, B and C". */
	const listNames = (names: string[]) =>
		new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' }).format(names);
</script>

<main>
	<!-- One GET form, so changing one filter keeps the other. Each select
	     submits it on change, with no Show button. Matches the activity page. -->
	<form class="filters" method="GET" action={resolve('/turfs/organizer')}>
		<div class="filter">
			<label for="chapter">Chapter</label>
			<select id="chapter" name="chapter" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
				<option value="" selected={data.chapter === null}>All chapters</option>
				{#each data.chapters as chapter (chapter.chapterId)}
					<option
						value={chapter.chapterId}
						selected={data.chapter?.chapterId === chapter.chapterId}
					>
						{chapter.name}
					</option>
				{/each}
			</select>
		</div>
		{#if data.campaigns.length > 1}
			<div class="filter">
				<label for="campaign">Campaign</label>
				<select
					id="campaign"
					name="campaign"
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				>
					<option value="" selected={data.campaign === null}>All campaigns</option>
					{#each data.campaigns as campaign (campaign.id)}
						<option value={campaign.id} selected={data.campaign?.id === campaign.id}>
							{campaign.name}
						</option>
					{/each}
				</select>
			</div>
		{/if}
		<a class="cross-link" href={resolve('/turfs/activity')}>See what already happened →</a>
		<a class="cross-link" href={resolve('/turfs/organizer/mentor-walks')}>Mentor walks →</a>
	</form>

	<!-- For turf just cut in VAN to answer a request: pull the catalog now
	     rather than at the next scheduled sync. Works with JavaScript off too. -->
	<form
		class="van-sync"
		method="POST"
		action="?/syncVan"
		use:enhance={() => {
			syncStarting = true;
			return async ({ update }) => {
				await update();
				// The load just read the press afresh.
				polled = null;
				syncStarting = false;
			};
		}}
	>
		<button type="submit" class="van-sync-button" disabled={syncStarting}>
			{syncStarting ? 'Starting…' : 'Sync VAN now'}
		</button>
		<p
			class="van-sync-status"
			class:is-error={form?.syncError || (sync?.stalled && !form?.syncJoined)}
			role="status"
		>
			{#if form?.syncError}
				{form.syncError}
			{:else if form?.syncJoined}
				A sync is already running. It will read VAN again within a couple of minutes and pick up
				your new turf — no need to press again.
			{:else if sync}
				{sync.status}
				<!-- A press's report must not hide a campaign whose syncs have
				     failed since. -->
				{#if lastSyncFailed}
					{@render lastSynced(data.lastVanSync.perCampaign ?? [])}
				{/if}
			{:else if form?.syncQueued}
				A scheduled sync is running now. Your new turf will load automatically once it finishes,
				then its map shapes — no need to press again.
			{:else if form?.syncStarted}
				Sync started. New turf usually shows up within a few minutes, then appears on the map as its
				shape loads — reload to check.
			{:else if data.lastVanSync.perCampaign}
				{@render lastSynced(data.lastVanSync.perCampaign)}
			{:else if data.lastVanSync.label}
				VAN last synced {data.lastVanSync.label}.
			{:else}
				VAN has not synced yet.
			{/if}
		</p>
	</form>

	{#snippet lastSynced(campaigns: NonNullable<typeof data.lastVanSync.perCampaign>)}
		VAN last synced:
		{#each campaigns as campaign, i (campaign.id)}
			{i > 0 ? ' · ' : ''}{campaign.name}
			{campaign.label ?? 'not yet'}{#if campaign.failed}
				(<a
					class="van-sync-failed"
					href={resolve('/settings/van/[campaignId]', { campaignId: String(campaign.id) })}
					>last sync failed</a
				>){/if}{i === campaigns.length - 1 ? '.' : ''}
		{/each}
	{/snippet}

	{#if sync && !form?.syncError}
		<!-- What the press found: kept apart from the status line, which is a
		     live region, so a poll does not read the whole list out again. -->
		<div class="van-sync-report">
			{#if sync.notes.length > 0}
				<ul class="van-sync-notes">
					{#each sync.notes as note, i (i)}
						<li class:is-error={note.error}>
							{note.text}
							{#if note.campaignId !== undefined}
								<a
									href={resolve('/settings/van/[campaignId]', {
										campaignId: String(note.campaignId),
									})}>Campaign settings</a
								>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if sync.newTurf.length > 0}
				<p class="van-sync-new-heading">
					{sync.running ? 'Picked up so far' : 'Picked up'}:
					{sync.newTurfTotal.toLocaleString('en-US')} new requested turf{sync.newTurfTotal >
					sync.newTurf.length
						? ` (the first ${sync.newTurf.length} below; the rest are under Requested turf)`
						: ''}
				</p>
				<ul class="van-sync-new">
					{#each sync.newTurf as turf (turf.turfId)}
						<li class:is-ready={turf.ready}>
							<span class="turf-name">{turf.name}</span>
							{#if turf.regionName}<span class="turf-sub">{turf.regionName}</span>{/if}
							<span class="van-sync-new-status">{turf.label}</span>
							{#each turf.caveats as caveat (caveat)}
								<span class="van-sync-new-caveat">{caveat}</span>
							{/each}
						</li>
					{/each}
				</ul>
			{:else if sync.running}
				<p class="van-sync-new-heading">No new requested turf yet.</p>
			{/if}
		</div>
	{/if}

	<!-- Counts first: on a canvass morning this row is the whole answer. -->
	<ul class="summary">
		<li class="summary-item">
			<span class="summary-count">{data.summary.turfsOut.toLocaleString('en-US')}</span>
			<span class="summary-label">turfs out</span>
		</li>
		<li class="summary-item">
			<span class="summary-count">{data.summary.holders.toLocaleString('en-US')}</span>
			<span class="summary-label">volunteers</span>
		</li>
		<li class="summary-item">
			<span class="summary-count">{data.summary.doorsOut.toLocaleString('en-US')}</span>
			<span class="summary-label">doors out</span>
		</li>
		{#if data.summary.expiring > 0}
			<li class="summary-item is-alert">
				<span class="summary-count">{data.summary.expiring.toLocaleString('en-US')}</span>
				<span class="summary-label">expiring soon</span>
			</li>
		{/if}
	</ul>

	{#if data.geometry.pending > 0 || data.geometry.failed > 0}
		<!-- Turf shapes are derived one export job per turf, so after a big
		     catalog sync the map is honestly half pins for a while. Shown only
		     while that is true, so it does not become furniture. -->
		<p class="callout is-quiet">Turf shapes: {data.geometry.label}</p>
	{/if}

	{#if data.summary.expiringUnwarned > 0}
		<!-- The one line that means someone has to act personally: about to lapse
		     AND the automatic reminder has not reached them. -->
		<p class="callout">
			{data.summary.expiringUnwarned}
			{data.summary.expiringUnwarned === 1 ? 'turf is' : 'turfs are'} expiring and the volunteer hasn't
			been reminded yet — the reminder goes out six hours before expiry, so these may need a word directly.
		</p>
	{/if}

	<section class="board">
		<h2>Out right now</h2>
		{#if data.holdings.length === 0}
			<p class="empty">
				No turf is checked out in {scope} at the moment.
			</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Turf</th>
							<th>Volunteer</th>
							<th>Held for</th>
							<th>Walked</th>
							<th>Expires</th>
							<th class="col-flag">Reminder</th>
						</tr>
					</thead>
					<tbody>
						{#each data.holdings as held (held.checkoutId)}
							<tr class="urgency-{held.urgency}">
								<td>
									<span class="turf-name">{held.turfName}</span>
									{#if held.regionName}
										<span class="turf-sub">{held.regionName}</span>
									{/if}
									<span class="turf-sub">
										{held.doorCount.toLocaleString('en-US')} doors left · {held.chapterName}{campaignSuffix(
											held.campaignId,
										)}
									</span>
								</td>
								<td><HolderName name={held.slackUserName} account={held.account} /></td>
								<td class="col-num">
									{held.hoursHeld}h
									<span class="turf-sub">{held.claimedAgoLabel}</span>
								</td>
								<!-- Doors VAN shows knocked since the claim: what the holder's
								     "I synced MiniVAN" check counts, as up to date as the live
								     poll. A dash when the turf has no roster to count against. -->
								<td class="col-num">
									{#if held.walked}
										{held.walked.percent}%
										<span class="turf-sub">
											{held.walked.knocked.toLocaleString('en-US')} of {held.walked.doors.toLocaleString(
												'en-US',
											)} doors
										</span>
									{:else}
										<span title="This turf's doors can't be counted yet">—</span>
									{/if}
								</td>
								<td class="col-num">
									<span class="expires-in">{hoursLabel(held.hoursLeft)}</span>
									<span class="turf-sub">{held.expiresLabel}</span>
								</td>
								<td class="col-flag">
									{#if held.urgency === 'expiring' && !held.warned}
										<span class="badge badge-unwarned">Not reminded</span>
									{:else if held.warned}
										<span class="badge badge-warned">Reminded</span>
									{:else}
										<span class="badge badge-none">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="board">
		<h2>Completed but nothing cleared</h2>
		{#if !data.deltaChecked}
			<!-- Not "all clear". Nothing has been measured, and saying otherwise
			     would report a check that has never run as a passing one. -->
			<p class="empty">
				Not checked yet. After a volunteer marks turf done, the next time VAN re-cuts that region
				the new door count is compared with the count when they claimed it — a count that didn't
				move usually means MiniVAN was never synced and the results are still on their phone.
				{#if data.regionRefresh.off.length === 0}
					The sync asks VAN to re-cut a region once turf in it is finished, so this normally fills
					in within a day.
				{:else if data.regionRefresh.on.length === 0}
					Automatic re-cuts are off (each campaign's page under Settings → VAN campaigns), so this
					only happens when an organizer re-cuts a region in VAN by hand.
				{:else}
					For {listNames(data.regionRefresh.on)}, the sync asks VAN to re-cut a region once turf in
					it is finished, so this normally fills in within a day. Automatic re-cuts are off for
					{listNames(data.regionRefresh.off)} (each campaign's page under Settings → VAN campaigns), so
					for that turf this only happens when an organizer re-cuts a region in VAN by hand.
				{/if}
				Nothing here has been verified either way.
				{#if data.completionsExamined > 0}
					<br />
					{data.completionsExamined.toLocaleString('en-US')} recent
					{data.completionsExamined === 1 ? 'completion is' : 'completions are'} waiting on it.
				{/if}
			</p>
		{:else if data.suspects.length === 0}
			<p class="empty">
				Every checked completion cleared doors. Nothing looks like a missed sync in {scope}.
			</p>
		{:else}
			<p class="section-note">
				These were marked done, but VAN's door count didn't move — almost always a MiniVAN that was
				never synced, so the canvass results are still on a phone.
			</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Turf</th>
							<th>Volunteer</th>
							<th>Completed</th>
						</tr>
					</thead>
					<tbody>
						{#each data.suspects as suspect (suspect.checkoutId)}
							<tr>
								<td>
									<span class="turf-name">{suspect.turfName}</span>
									{#if suspect.regionName}
										<span class="turf-sub">{suspect.regionName}</span>
									{/if}
									<span class="turf-sub"
										>{suspect.chapterName}{campaignSuffix(suspect.campaignId)}</span
									>
								</td>
								<td><HolderName name={suspect.slackUserName} account={suspect.account} /></td>
								<td class="col-num">
									{suspect.completedLabel}
									<span class="turf-sub">{suspect.completedAgoLabel}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="board">
		<h2>Out of step with VAN</h2>
		{#if data.drift.visibility === 'van-side-unavailable'}
			<!-- Not "no drift". van_distributed_to is incomplete both when the
			     tier that reads exports is not granted and while the sync is still
			     backfilling them, so an empty list here would be reassurance drawn
			     from a question nobody asked. -->
			<p class="empty">
				Can't check right now. Comparing our checkout list against MiniVAN needs VAN's
				<code>/minivanExports</code>, and the last sync couldn't finish reading it — either the API
				key can't read it, VAN failed, or the app is still loading the last 30 days of exports.
				Nothing here has been compared either way.
			</p>
		{:else if data.drift.visibility === 'exports-unused'}
			<!-- Also not "no drift". Nothing in this catalog has ever appeared in a
			     MiniVAN export, which means the campaign hands out printed list
			     NUMBERS rather than assigning lists to named canvassers in VAN. A
			     list number loads in MiniVAN without an export record existing, so
			     "claimed here, not in MiniVAN" would be true of every claim ever
			     made and would mean nothing. -->
			<p class="empty">
				Not checked. No turf in {scope} appears in any MiniVAN export, so there is nothing to compare
				against — this campaign hands out printed list numbers rather than assigning lists to canvassers
				inside VAN. A list number loads in MiniVAN either way. This check switches itself back on as soon
				as one export matches.
			</p>
		{:else if data.drift.items.length === 0}
			<p class="empty">
				Our checkout list and MiniVAN agree in {scope}. Nothing is claimed here without being in
				MiniVAN.
			</p>
		{:else}
			<p class="section-note">
				The app and VAN disagree about {data.drift.items.length}
				{data.drift.items.length === 1 ? 'turf' : 'turfs'}: claimed here, but the volunteer hasn't
				loaded the list in MiniVAN yet.
			</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th class="col-flag">Problem</th>
							<th>Turf</th>
							<th>Who has it</th>
							<th>What to do</th>
						</tr>
					</thead>
					<tbody>
						{#each data.drift.items as item (item.kind + ':' + item.turfId)}
							<tr class="drift-{item.kind}">
								<td class="col-flag">
									<span class="badge badge-{item.kind}">{driftLabel(item.kind)}</span>
								</td>
								<td>
									<span class="turf-name">{item.turfName}</span>
									{#if item.regionName}
										<span class="turf-sub">{item.regionName}</span>
									{/if}
									<span class="turf-sub">
										{item.doorCount.toLocaleString('en-US')} doors · {item.chapterName}{campaignSuffix(
											item.campaignId,
										)}
									</span>
								</td>
								<td>
									<HolderName name={item.heldBy} account={item.account} />
									{#if !item.hasListNumber}
										<span class="turf-sub">no MiniVAN list number</span>
									{/if}
								</td>
								<td class="drift-advice">{driftAdvice(item.kind)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	{#if data.requestedTurf.length > 0}
		<section class="board">
			<h2>Requested turf</h2>
			{#if form?.placeError}
				<p class="section-note is-error" role="alert">{form.placeError}</p>
			{/if}
			<p class="section-note">
				Turf cut into a campaign's requested-turf folder goes to the chapter where it is: the ZIP it
				falls in, or failing that the chapter most of the turf around it belongs to — and to any
				chapter the folder is mapped to as well. Pick a chapter to move one; <strong
					>Automatic</strong
				>
				hands it back. Until it is placed, only a chapter the folder is mapped to sees it.
			</p>
			{#if data.requestedTotal > data.requestedTurf.length}
				<p class="section-note">
					Showing {data.requestedTurf.length} of {data.requestedTotal.toLocaleString('en-US')},
					those not placed yet first, then the newest.
				</p>
			{/if}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Turf</th>
							<th>How</th>
							<th>Chapter</th>
						</tr>
					</thead>
					<tbody>
						{#each data.requestedTurf as turf (turf.turfId)}
							<tr>
								<td>
									<span class="turf-name">{turf.name}</span>
									{#if turf.regionName}
										<span class="turf-sub">{turf.regionName}{campaignSuffix(turf.campaignId)}</span>
									{/if}
									<span class="turf-sub">First seen {turf.firstSeenAgoLabel}</span>
								</td>
								<td>
									{turf.placedLabel}
									{#each turf.caveats as caveat (caveat)}
										<span class="turf-sub is-caveat">{caveat}</span>
									{/each}
								</td>
								<td>
									<!-- One form per row, sent as soon as the choice changes. A
									     refusal resets the form, which puts the old choice back:
									     `selected` is the default, not a binding. -->
									<form
										method="POST"
										action="?/placeTurf"
										use:enhance={() => {
											placing[turf.turfId] = true;
											return async ({ result, update, formElement }) => {
												await update();
												if (result.type !== 'success') formElement.reset();
												delete placing[turf.turfId];
											};
										}}
									>
										<input type="hidden" name="turfId" value={turf.turfId} />
										<select
											name="chapterId"
											disabled={placing[turf.turfId]}
											aria-label="Chapter for {turf.name}"
											onchange={(e) => e.currentTarget.form?.requestSubmit()}
										>
											<option value="" selected={turf.placement?.source !== 'organizer'}>
												Automatic{turf.placement && turf.placement.source !== 'organizer'
													? ` (${turf.placement.chapterName})`
													: ''}
											</option>
											{#each data.placementChoices as choice (choice.chapterId)}
												<option
													value={choice.chapterId}
													selected={turf.placement?.source === 'organizer' &&
														turf.placement.chapterId === choice.chapterId}
												>
													{choice.name}
												</option>
											{/each}
										</select>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<section class="board">
		<h2>Hidden from volunteers</h2>
		{#if form?.unhideError}
			<p class="section-note is-error" role="alert">{form.unhideError}</p>
		{/if}
		{#if data.hidden.length === 0}
			<p class="empty">
				No turf is hidden in {scope}. An organizer can hide turf from the bottom of its card on the
				turf page.
			</p>
		{:else}
			<p class="section-note">
				Volunteers can't see or check out these. Untick one to put it back on the turf page.
			</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Turf</th>
							<th>Hidden by</th>
							<th class="col-flag">Hidden</th>
						</tr>
					</thead>
					<tbody>
						{#each data.hidden as turf (turf.turfId)}
							<tr>
								<td>
									<span class="turf-name">{turf.turfName}</span>
									{#if turf.regionName}
										<span class="turf-sub">{turf.regionName}</span>
									{/if}
									<span class="turf-sub">
										{turf.doorCount.toLocaleString('en-US')} doors · {turf.chapterName}{campaignSuffix(
											turf.campaignId,
										)}
									</span>
								</td>
								<td>
									{turf.hiddenBy ?? '—'}
									<span class="turf-sub">{turf.hiddenAgoLabel}</span>
								</td>
								<td class="col-flag">
									<!-- One form per row, sent as soon as the box is unticked.
									     A refusal resets the form, which ticks the box back:
									     `checked` here is the box's default, not a binding. -->
									<form
										method="POST"
										action="?/unhide"
										use:enhance={() => {
											unhiding[turf.turfId] = true;
											return async ({ result, update, formElement }) => {
												await update();
												if (result.type !== 'success') formElement.reset();
												delete unhiding[turf.turfId];
											};
										}}
									>
										<input type="hidden" name="turfId" value={turf.turfId} />
										<input
											class="unhide-check"
											type="checkbox"
											checked
											disabled={unhiding[turf.turfId]}
											aria-label="Hidden: untick to show {turf.turfName} to volunteers"
											onchange={(e) => e.currentTarget.form?.requestSubmit()}
										/>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="board">
		<h2>Turf history</h2>
		<p class="section-note">
			Every cut of a turf in VAN, when its doors were knocked, and who claimed it here — for when a
			volunteer says they knocked a turf that now looks untouched. Search part of a turf's name, its
			region, or its turf id.
		</p>
		<!-- Enter submits it like the button. The answer goes to `searched`, not
		     through update(): a search must not reload the board above, nor
		     touch `form`, which the other actions on this page answer through. -->
		<form
			class="history-search"
			method="POST"
			action="?/turfHistory"
			use:enhance={() => {
				historyLoading = true;
				return async ({ result, update }) => {
					if (result.type === 'success' || result.type === 'failure') {
						searched = result.data as HistoryResult;
					} else {
						await update();
					}
					historyLoading = false;
				};
			}}
		>
			<input
				class="history-input"
				type="search"
				name="query"
				value={history?.historyQuery ?? ''}
				placeholder="R02F_037_Kent_PlainfieldTowns_003 Turf 05"
				aria-label="Turf name, region, or turf id"
				required
			/>
			<button type="submit" class="van-sync-button" disabled={historyLoading}>
				{historyLoading ? 'Loading…' : 'Look up'}
			</button>
		</form>

		{#if history?.historyError}
			<p class="section-note is-error" role="alert">{history.historyError}</p>
		{:else if history?.histories}
			{#if history.histories.length === 0}
				<p class="empty">No turf matches “{history.historyQuery}”.</p>
			{:else if history.historyTruncated}
				<p class="section-note">
					Showing the first {history.histories.length} matches. Search a turf's full name or id to see
					one that isn't here.
				</p>
			{/if}
			{#each history.histories as turf (turf.campaignId + ':' + turf.name)}
				<div class="history-turf">
					<h3 class="history-name">
						{turf.name}<span class="turf-sub">{campaignSuffix(turf.campaignId)}</span>
					</h3>
					{#if turf.why}
						<p class="callout is-quiet">{turf.why}</p>
					{/if}
					{#if turf.doorsNow}
						<!-- The turf as it stands: every door in the live cut, by the day
						     it was last knocked, whichever cut that was under. -->
						<p class="section-note">
							{turf.doorsNow.doors.toLocaleString('en-US')} doors in the turf now ·
							{turf.doorsNow.knocked.toLocaleString('en-US')} knocked. Each door counts once, on the day
							it was last knocked — only a door's latest knock is kept.
						</p>
						{#if turf.doorsNow.byDay.length > 0}
							<div class="table-wrap history-days">
								<table>
									<thead>
										<tr>
											<th>Day</th>
											<th class="col-num">Doors knocked</th>
										</tr>
									</thead>
									<tbody>
										{#each turf.doorsNow.byDay as day (day.day)}
											<tr>
												<td>{day.day}</td>
												<td class="col-num">{day.doors.toLocaleString('en-US')}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}
					{/if}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Cut</th>
									<th>Doors</th>
									<th>Knocked</th>
									<th>Claims here</th>
								</tr>
							</thead>
							<tbody>
								{#each turf.cuts as cut (cut.turfId)}
									<tr>
										<td>
											<span class="turf-name">{campaignSheetStamp(cut.cutAt)}</span>
											<span class="turf-sub">
												{cut.retiredAt ? `retired ${campaignSheetStamp(cut.retiredAt)}` : 'Live'}
											</span>
											<span class="turf-sub">
												turf {cut.turfId} · list {cut.savedListId ?? '—'}
											</span>
										</td>
										<td class="col-num">
											{cut.doorCount.toLocaleString('en-US')} in VAN
											<span class="turf-sub">
												{#if cut.uncontactedDoors !== null && cut.rosterCurrent}
													app shows {cut.uncontactedDoors.toLocaleString('en-US')} left
												{:else}
													no roster — app shows VAN's count
												{/if}
											</span>
										</td>
										<td>
											{#if cut.rosterDoors === null}
												<span class="turf-sub">No roster, so no knock history</span>
											{:else}
												{cut.knockedSinceCut} of {cut.rosterDoors} since this cut
												{#if cut.knockedBeforeCut > 0}
													<span class="turf-sub">
														{cut.knockedBeforeCut} before it (not counted against this cut)
													</span>
												{/if}
												{#if cut.knockedByDay.length > 0}
													<span class="turf-sub">
														By day of latest knock: {cut.knockedByDay
															.map((d) => `${d.day} ${d.doors}`)
															.join(', ')}
													</span>
												{/if}
											{/if}
										</td>
										<td>
											{#if cut.claims.length === 0}
												<span class="turf-sub">None</span>
											{:else}
												<ul class="history-claims">
													{#each cut.claims as claim (claim.checkoutId)}
														<li>
															{claim.slackUserName}
															<span class="turf-sub">
																claimed {campaignSheetStamp(claim.claimedAt)} ·
																{#if claim.completedAt}
																	marked walked {campaignSheetStamp(
																		claim.completedAt,
																	)}{claim.reportedPercent !== null
																		? ` at ${claim.reportedPercent}%`
																		: ''}
																{:else if claim.releasedAt}
																	{claim.releaseReason ?? 'released'}
																	{campaignSheetStamp(claim.releasedAt)}
																{:else}
																	still held
																{/if}
																{#if claim.doorsKnocked !== null}
																	· {claim.doorsKnocked} doors knocked
																{/if}
															</span>
														</li>
													{/each}
												</ul>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{/each}
		{/if}
	</section>
</main>
