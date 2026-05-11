<script lang="ts">
	import { BarChart, Bars } from 'layerchart';
	import type { ChartFrame } from './chart-data.js';

	type Props = {
		variant: 'overview' | 'detail';
		frame: ChartFrame;
		accessibleName: string;
		showTotalOverlay?: boolean;
	};

	let { variant, frame, accessibleName, showTotalOverlay = false }: Props = $props();

	type Row = Record<string, string | number>;

	const rows = $derived.by<Row[]>(() => {
		return frame.dates.map((date, i) => {
			const row: Row = { date };
			for (const band of frame.bands) {
				row[band.key] = band.values[i] ?? 0;
			}
			if (frame.dailyTotals) row.__total = frame.dailyTotals[i] ?? 0;
			return row;
		});
	});

	const BAND_COLORS = [
		'#2563eb',
		'#dc2626',
		'#16a34a',
		'#f59e0b',
		'#9333ea',
		'#0891b2',
		'#db2777',
		'#65a30d',
		'#7c3aed',
		'#ea580c',
		'#94a3b8',
		'#475569'
	];

	const series = $derived(
		frame.bands.map((band, i) => ({
			key: band.key,
			label: band.label,
			value: (d: Row) => (d[band.key] as number | undefined) ?? 0,
			color: BAND_COLORS[i % BAND_COLORS.length]
		}))
	);
</script>

<div
	class="signup-chart"
	class:overview={variant === 'overview'}
	class:detail={variant === 'detail'}
	role="img"
	aria-label={accessibleName}
>
	{#if frame.bands.length === 0 || frame.dates.length === 0}
		<p class="signup-chart__empty">No data</p>
	{:else}
		<BarChart
			data={rows}
			x="date"
			{series}
			seriesLayout={variant === 'detail' ? 'stack' : 'overlap'}
			tooltipContext={variant === 'detail'}
			legend={variant === 'detail'}
			grid={variant === 'detail'}
		>
			{#snippet marks({ context }: { context: { series: { visibleSeries: Array<{ key: string }> }; xScale: (v: unknown) => number; yScale: (v: unknown) => number } })}
				{#each context.series.visibleSeries as s (s.key)}
					<Bars seriesKey={s.key} radius={3} />
				{/each}
				{#if showTotalOverlay && frame.dailyTotals}
					{#each frame.dates as date, i (date)}
						{@const x1 = context.xScale(date)}
						{@const bw =
							(context.xScale as unknown as { bandwidth?: () => number }).bandwidth?.() ?? 8}
						{@const y = context.yScale(frame.dailyTotals[i] ?? 0)}
						<line
							x1={x1}
							x2={x1 + bw}
							y1={y}
							y2={y}
							stroke="#111827"
							stroke-width="2"
						/>
					{/each}
				{/if}
			{/snippet}
		</BarChart>
	{/if}
</div>

<style>
	.signup-chart {
		width: 100%;
		height: 280px;
	}
	.signup-chart.detail {
		height: 360px;
	}
	.signup-chart__empty {
		color: #6b7280;
		text-align: center;
		padding: 4rem 0;
	}
	/* LayerChart's swatch group is `display: flex` with no wrap, so on detail
	   pages with many chapters the legend overflows the card. Constrain it to
	   the chart width and let it wrap onto multiple rows. */
	.signup-chart :global(.lc-legend-container) {
		display: block;
		max-width: 100%;
	}
	.signup-chart :global(.lc-legend-swatch-group) {
		flex-wrap: wrap;
		row-gap: 0.35rem;
	}
</style>
