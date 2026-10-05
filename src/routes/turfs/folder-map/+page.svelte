<script lang="ts">
	// Which VAN folder covers which counties — the page for deciding what each
	// folder should be mapped to on its campaign's page under Settings → VAN
	// campaigns.
	//
	// Names, not geometry: see the note in +page.server.ts. The caption and the
	// note below say so on the page too, because a dot on a street map invites
	// exactly the wrong reading ("that is where the turf is").
	//
	// The VAN read is streamed: the header and state picker render at once, and
	// everything below waits on `data.folderData` behind a spinner.

	import FolderCountyMap from '$lib/components/turfs/FolderCountyMap.svelte';
	import FolderChapterPicker from '$lib/components/turfs/FolderChapterPicker.svelte';
	import type { MapDot } from '$lib/components/turfs/FolderCountyMap.svelte';
	import { chartBands } from '$lib/styles/chart-bands.svelte.js';
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';
	import type { FolderData, FolderSummary } from './+page.server.js';

	let { data }: { data: PageData } = $props();

	const bands = chartBands();
	let highlight = $state<number | null>(null);

	/** One colour per folder, cycling the theme's categorical bands. */
	const colourFor = $derived((index: number) => bands.current[index % bands.current.length]!);

	/** The query string for this campaign, keeping the picked state. */
	const stateQuery = $derived(data.pickedState ? `&state=${data.pickedState}` : '');

	function dotsFor(fd: FolderData): MapDot[] {
		return fd.folders.flatMap((folder, i) =>
			folder.counties.map((county): MapDot => ({
				key: `${folder.folderId}:${county.county}`,
				centre: county.centre,
				routes: county.routes,
				colour: colourFor(i),
				folderId: folder.folderId,
				label: `${folder.name} — ${county.county} County: ${county.routes} turf(s) in ${county.regions} region(s)`,
			})),
		);
	}

	function totalsFor(fd: FolderData) {
		return {
			folders: fd.folders.length,
			routes: fd.folders.reduce((n, f) => n + f.routes, 0),
			unplaced: fd.folders.reduce((n, f) => n + f.unplaced.length, 0),
		};
	}

	/** The chapters already mapped to a folder. */
	function mappedChapters(fd: FolderData, folderId: number) {
		return fd.mapping.find((m) => m.folderId === folderId)?.chapters ?? [];
	}

	/** "Wayne (23), Oakland (1)" — the counties a folder actually covers. */
	function countyList(folder: FolderSummary): string {
		return folder.counties.map((c) => `${c.county} (${c.routes})`).join(', ');
	}
</script>

<svelte:head><title>VAN folders by county</title></svelte:head>

<main>
	<header>
		<h1>VAN folders by county — {data.campaign.name}</h1>
		{#if data.campaigns.length > 1}
			<nav class="campaigns" aria-label="Campaign">
				{#each data.campaigns as c (c.id)}
					<a
						href="{resolve('/turfs/folder-map')}?campaign={c.id}"
						aria-current={c.id === data.campaign.id ? 'page' : undefined}>{c.name}</a
					>
				{/each}
			</nav>
		{/if}
		<p class="note">
			Where each VAN folder's turf is, worked out from the county in each region's name. Every dot
			sits at a
			<strong>county centroid</strong>, sized by how much turf the folder has there — it is not the
			turf's real shape or position. Pick the chapters that should see each folder in the last
			column.
		</p>
		<!-- A GET form, so SvelteKit handles it as a navigation: the cached VAN
		     read is re-placed in the picked state without asking VAN again. -->
		<form class="state-picker" method="GET" action={resolve('/turfs/folder-map')}>
			<input type="hidden" name="campaign" value={data.campaign.id} />
			<label>
				Look up counties in
				<select
					name="state"
					value={data.pickedState ?? ''}
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				>
					<option value=""
						>{data.configuredStates.length > 0
							? `Default (${data.configuredStates.join(', ')})`
							: 'Auto-detect from region names'}</option
					>
					{#each data.stateOptions as code (code)}
						<option value={code}>{code}</option>
					{/each}
				</select>
			</label>
			<noscript><button type="submit">Apply</button></noscript>
		</form>
	</header>

	{#await data.folderData}
		<div class="loading" role="status">
			<span class="spinner" aria-hidden="true"></span>
			Reading folders from VAN…
		</div>
	{:then fd}
		{@render folderPage(fd)}
	{/await}
</main>

{#snippet folderPage(fd: FolderData)}
	{#if fd.states.length > 0}
		<p class="note">
			Counties read in {fd.states.join(', ')}{fd.statesSource === 'picked'
				? ' (picked above).'
				: fd.statesSource === 'configured'
					? ' (from CAMPAIGN_STATES).'
					: ' — worked out from the region names. Pick a state above, or set CAMPAIGN_STATES to pin it.'}
		</p>
	{/if}
	{#if fd.fetchedAt}
		<p class="note">
			Read live from VAN, cached for 10 minutes.
			<a
				href="{resolve('/turfs/folder-map')}?campaign={data.campaign.id}{stateQuery}&refresh=1"
				data-sveltekit-reload>Refresh now</a
			>
		</p>
	{/if}

	{#if fd.error}
		<p class="error">Could not read folders from VAN: {fd.error}</p>
	{:else if fd.folders.length === 0}
		{#if fd.emptyFolders.length === 0 && fd.errors.length === 0}
			<p class="note">
				This key can see no folders. Share the campaign's folders with its API user in VAN.
			</p>
		{:else if fd.emptyFolders.length === 0}
			<!-- Folders exist, but VAN refused their regions: the errors below say
			     why, and "share the folders" would send the admin the wrong way. -->
			<p class="note">
				VAN would not show the regions in any folder this key can see — see below for why.
			</p>
		{:else}
			<p class="note">
				This key can see {fd.emptyFolders.length}
				folder{fd.emptyFolders.length === 1 ? '' : 's'}, but none has turf cut yet — no map regions
				in any of them. Map them to chapters now if you like; their turf appears after the next sync
				once regions are cut in VAN.
			</p>
			{@render chapterNotes(fd)}
			{@render emptyFolderTable(fd, false)}
		{/if}
	{:else}
		{@const totals = totalsFor(fd)}
		<p class="totals">
			{totals.folders} folder{totals.folders === 1 ? '' : 's'} with turf · {totals.routes.toLocaleString(
				'en-US',
			)} turfs
			{#if totals.unplaced > 0}· {totals.unplaced} region(s) whose name names no county{/if}
		</p>

		<FolderCountyMap
			dots={dotsFor(fd)}
			tiles={data.tiles}
			fallbackBounds={fd.fallbackBounds}
			highlightFolderId={highlight}
		/>

		<ul class="legend">
			{#each fd.folders as folder, i (folder.folderId)}
				<li>
					<button
						type="button"
						class:active={highlight === folder.folderId}
						onclick={() => (highlight = highlight === folder.folderId ? null : folder.folderId)}
						onmouseenter={() => (highlight = folder.folderId)}
						onmouseleave={() => (highlight = null)}
					>
						<span class="swatch" style:background={colourFor(i)}></span>
						<span class="name">{folder.name}</span>
						<span class="count">{folder.routes.toLocaleString('en-US')}</span>
					</button>
				</li>
			{/each}
		</ul>

		{@render chapterNotes(fd)}

		<table>
			<caption>
				Pick the chapters that should see each folder — saved as you pick, to the same mapping
				/settings edits chapter-first.
			</caption>
			<thead>
				<tr>
					<th scope="col">Folder</th>
					<th scope="col">Id</th>
					<th scope="col">Regions</th>
					<th scope="col">Turfs</th>
					<th scope="col">Counties (turfs)</th>
					<th scope="col">Chapters that see this folder</th>
				</tr>
			</thead>
			<tbody>
				{#each fd.folders as folder (folder.folderId)}
					<tr class:highlighted={highlight === folder.folderId}>
						<th scope="row">{folder.name}</th>
						<td><code>{folder.folderId}</code></td>
						<td class="num">{folder.regions}</td>
						<td class="num">{folder.routes.toLocaleString('en-US')}</td>
						<td>
							{countyList(folder)}
							{#if folder.unplaced.length > 0}
								<span class="unplaced"
									>· {folder.unplaced.length} region(s) with no county in the name: {folder.unplaced
										.slice(0, 3)
										.join(', ')}{folder.unplaced.length > 3 ? '…' : ''}</span
								>
							{/if}
						</td>
						<td class="chapters-cell">
							<FolderChapterPicker
								campaignId={data.campaign.id}
								folderId={folder.folderId}
								folderName={folder.name}
								chapters={fd.chapters}
								selected={mappedChapters(fd, folder.folderId)}
							/>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		{#if fd.emptyFolders.length > 0}
			{@render emptyFolderTable(fd, true)}
		{/if}
	{/if}

	{#if fd.errors.length > 0}
		<section class="folder-errors">
			<h2>Folders VAN would not show</h2>
			<ul>
				{#each fd.errors as line (line)}<li>{line}</li>{/each}
			</ul>
		</section>
	{/if}
{/snippet}

{#snippet chapterNotes(fd: FolderData)}
	{#if fd.chaptersError}
		<p class="note">Chapter list unavailable: {fd.chaptersError}</p>
	{/if}
	{#if fd.mappingError}
		<p class="note">Existing mapping could not be read: {fd.mappingError}</p>
	{/if}
{/snippet}

<!-- Folders with no map region cut yet: nothing to put on the map, but
     still worth mapping to chapters ahead of the cut. -->
{#snippet emptyFolderTable(fd: FolderData, withHeading: boolean)}
	{#if withHeading}
		<h2 class="empty-heading">Folders with no turf cut yet</h2>
	{/if}
	<table>
		<thead>
			<tr>
				<th scope="col">Folder</th>
				<th scope="col">Id</th>
				<th scope="col">Chapters that see this folder</th>
			</tr>
		</thead>
		<tbody>
			{#each fd.emptyFolders as folder (folder.folderId)}
				<tr>
					<th scope="row">{folder.name}</th>
					<td><code>{folder.folderId}</code></td>
					<td class="chapters-cell">
						<FolderChapterPicker
							campaignId={data.campaign.id}
							folderId={folder.folderId}
							folderName={folder.name}
							chapters={fd.chapters}
							selected={mappedChapters(fd, folder.folderId)}
						/>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/snippet}

<style>
	.state-picker {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: var(--space-2) 0 0;
		font-size: var(--font-size-sm);
	}

	.state-picker select {
		margin-left: var(--space-2);
		font: inherit;
	}

	.loading {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-4) 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.spinner {
		display: block;
		width: 1em;
		height: 1em;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-blue);
		border-radius: 50%;
		animation: folder-map-spin 0.7s linear infinite;
	}

	@keyframes folder-map-spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Respect reduced-motion: the label alone carries the meaning. */
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 3s;
		}
	}
	.empty-heading {
		margin: 24px 0 8px;
		font-size: 1.05rem;
	}

	.campaigns {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin: 4px 0 8px;
	}

	.campaigns a[aria-current='page'] {
		font-weight: 600;
		text-decoration: none;
	}

	main {
		max-width: 72rem;
		margin: 0 auto;
		padding: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.note,
	.totals {
		margin: var(--space-2) 0 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.error {
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-error);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.legend button {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		font: inherit;
		font-size: var(--font-size-sm);
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		cursor: pointer;
	}

	.legend button.active {
		border-color: var(--color-border-focus);
	}

	.swatch {
		width: 0.85rem;
		height: 0.85rem;
		border-radius: 50%;
	}

	.legend .count {
		color: var(--color-text-muted);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--font-size-sm);
	}

	caption {
		margin-bottom: var(--space-2);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		text-align: left;
	}

	th,
	td {
		padding: var(--space-2);
		text-align: left;
		vertical-align: top;
		border-bottom: 1px solid var(--color-border);
	}

	tr.highlighted {
		background: var(--color-bg-hover);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.chapters-cell {
		min-width: 18rem;
	}

	.unplaced {
		color: var(--color-text-muted);
	}

	.folder-errors {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	@media (max-width: 40rem) {
		table {
			font-size: var(--font-size-xs);
		}
	}
</style>
