<script lang="ts">
	// Organizer oversight of walks (specs/015-mentor-walks, User Story 4,
	// FR-034/FR-035/FR-037): the headline numbers, upcoming walks they can hide
	// or cancel, and past walks with attendance and no-show reports.

	import './mentor-walks.css';
	import type { OrganizerPastWalkView, OrganizerWalkView } from '$lib/mentor-walks/types.js';

	interface Props {
		upcoming: OrganizerWalkView[];
		past: OrganizerPastWalkView[];
		/** The headline numbers (FR-037). Omitted until they're measured. */
		metrics?: {
			walksHosted: number;
			seatsOffered: number;
			seatsTaken: number;
			attendanceRate: string;
			noShowReports: number;
			completedOwnTurfWithin14Days: string;
		};
		onhide: (id: string) => void;
		oncancel: (id: string) => void;
	}

	let { upcoming, past, metrics, onhide, oncancel }: Props = $props();

	/** Hide and Cancel can't be undone, so each asks once. */
	let confirming = $state<{ id: string; action: 'hide' | 'cancel' } | null>(null);

	const tiles = $derived.by(() => {
		if (!metrics) return [];
		return [
			{ label: 'Walks hosted', value: metrics.walksHosted },
			{ label: 'Seats taken', value: `${metrics.seatsTaken} / ${metrics.seatsOffered}` },
			{ label: 'Attendance', value: metrics.attendanceRate },
			{ label: 'Walked own turf within 14 days', value: metrics.completedOwnTurfWithin14Days },
			{ label: 'No-show reports', value: metrics.noShowReports },
		];
	});

	const count = (n: number | null) => (n === null ? '—' : String(n));
</script>

<section class="mw-panel" aria-labelledby="mw-org-walks-heading">
	<h2 id="mw-org-walks-heading">Mentor walks</h2>

	{#if tiles.length > 0}
		<dl class="mw-tiles">
			{#each tiles as tile (tile.label)}
				<div class="mw-tile">
					<dt>{tile.label}</dt>
					<dd>{tile.value}</dd>
				</div>
			{/each}
		</dl>
	{/if}

	<h3>Upcoming</h3>
	{#if upcoming.length === 0}
		<p class="mw-muted">No upcoming walks.</p>
	{:else}
		<ul class="mw-list">
			{#each upcoming as walk (walk.id)}
				<li class="mw-row">
					<div class="mw-row-main">
						<strong>{walk.mentorName}</strong>
						<span class="mw-muted">{walk.chapterName}</span>
						<span>{walk.dayLabel} at {walk.timeLabel} · {walk.place}</span>
						<span class="mw-muted">
							{walk.joined.length} / {walk.seats} seats taken{walk.joined.length
								? `: ${walk.joined.join(', ')}`
								: ''}
						</span>
					</div>
					{#if walk.status !== 'scheduled'}
						<span class="mw-chip mw-chip-error">
							{walk.status === 'hidden' ? 'Hidden' : 'Cancelled'}{walk.statusByName
								? ` by ${walk.statusByName}`
								: ''}
						</span>
					{:else if confirming?.id === walk.id}
						<div class="mw-confirm">
							<p role="alert">
								{confirming.action === 'hide' ? 'Hide' : 'Cancel'} this walk? It disappears for everyone,
								and anyone who joined is told. This can't be undone.
							</p>
							<div class="mw-actions">
								<button
									type="button"
									class="mw-btn mw-btn-danger"
									onclick={() => {
										const chosen = confirming;
										confirming = null;
										if (chosen?.action === 'hide') onhide(chosen.id);
										else if (chosen) oncancel(chosen.id);
									}}
								>
									{confirming.action === 'hide' ? 'Hide it' : 'Cancel it'}
								</button>
								<button
									type="button"
									class="mw-btn mw-btn-ghost"
									onclick={() => (confirming = null)}
								>
									Keep it
								</button>
							</div>
						</div>
					{:else}
						<div class="mw-actions">
							<button
								type="button"
								class="mw-btn mw-btn-ghost"
								onclick={() => (confirming = { id: walk.id, action: 'hide' })}
							>
								Hide
							</button>
							<button
								type="button"
								class="mw-btn mw-btn-danger"
								onclick={() => (confirming = { id: walk.id, action: 'cancel' })}
							>
								Cancel
							</button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<h3>Past</h3>
	{#if past.length === 0}
		<p class="mw-muted">No walks yet.</p>
	{/if}
	<ul class="mw-list">
		{#each past as walk (walk.id)}
			<li class="mw-row">
				<div class="mw-row-main">
					<strong>{walk.mentorName}</strong>
					<span class="mw-muted">{walk.chapterName}</span>
					<span>{walk.dayLabel} · {walk.place}</span>
					<span class="mw-muted">
						{count(walk.taken)} / {walk.seats} seats taken · {count(walk.attended)} attended
					</span>
				</div>
				{#if walk.status && walk.status !== 'scheduled'}
					<span class="mw-chip">{walk.status === 'hidden' ? 'Hidden' : 'Cancelled'}</span>
				{/if}
				{#if walk.noShowReports > 0}
					<span class="mw-chip mw-chip-error">
						{walk.noShowReports} no-show {walk.noShowReports === 1 ? 'report' : 'reports'}
					</span>
				{/if}
			</li>
		{/each}
	</ul>
</section>

<style>
	.mw-tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
		gap: var(--space-2);
		margin: 0;
	}

	.mw-tile {
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
	}

	.mw-tile dt {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.mw-tile dd {
		margin: 0;
		font-size: var(--font-size-lg);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.mw-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.mw-confirm {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		flex-basis: 100%;
	}

	.mw-row-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
</style>
