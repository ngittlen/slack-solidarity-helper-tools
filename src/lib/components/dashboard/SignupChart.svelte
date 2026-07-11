<script lang="ts">
	import { BarChart, Bars } from 'layerchart';
	import { CHART_BAND_COLORS } from '$lib/styles/chart-colors';
	import {
		formatDateTick,
		thinDateTicks,
		type ChartBand,
		type ChartFrame,
	} from './chart-data.js';

	type Props = {
		variant: 'overview' | 'detail';
		frame: ChartFrame;
		/** Per-chapter bands for the legend. Always rendered so its footprint is
		 * reserved in both variants; visually hidden in overview mode. */
		legendBands: ChartBand[];
		accessibleName: string;
		showTotalOverlay?: boolean;
	};

	let { variant, frame, legendBands, accessibleName, showTotalOverlay = false }: Props = $props();

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

	const series = $derived(
		frame.bands.map((band, i) => ({
			key: band.key,
			label: band.label,
			value: (d: Row) => (d[band.key] as number | undefined) ?? 0,
			color: CHART_BAND_COLORS[i % CHART_BAND_COLORS.length]
		}))
	);

	// Built from legendBands (always the per-chapter bands) rather than `series`
	// so the legend's contents — and therefore its height — are identical in both
	// variants. Only visibility changes when toggling.
	const legendItems = $derived(
		legendBands.map((band, i) => ({
			key: band.key,
			label: band.label,
			color: CHART_BAND_COLORS[i % CHART_BAND_COLORS.length]
		}))
	);
</script>

<div
	class="signup-chart"
	role="img"
	aria-label={accessibleName}
>
	{#if frame.bands.length === 0 || frame.dates.length === 0}
		<p class="signup-chart__empty">No data</p>
	{:else}
		<div class="signup-chart__plot">
			<BarChart
				data={rows}
				x="date"
				{series}
				seriesLayout={variant === 'detail' ? 'stack' : 'overlap'}
				tooltipContext={variant === 'detail'}
				legend={false}
				grid={variant === 'detail'}
				padding={{ top: 4, left: 40, bottom: 20, right: 4 }}
				props={{
					// One tick per bar overlaps at the 30/90-day presets: thin to
					// MAX_X_TICKS labels and shorten each to MM/DD.
					xAxis: {
						ticks: (scale: { domain: () => string[] }) => thinDateTicks(scale.domain()),
						format: formatDateTick,
					},
				}}
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
								class="signup-chart__total-marker"
								stroke-width="2"
							/>
						{/each}
					{/if}
				{/snippet}
			</BarChart>
		</div>
		<!-- Always rendered so the legend's footprint is reserved in both
		     variants; only made visible in detail mode. -->
		<ul
			class="signup-chart__legend"
			class:signup-chart__legend--hidden={variant === 'overview'}
			aria-label="Chapter legend"
			aria-hidden={variant === 'overview'}
		>
			{#each legendItems as s (s.key)}
				<li class="signup-chart__legend-item">
					<span
						class="signup-chart__swatch"
						style:background-color={s.color}
						aria-hidden="true"
					></span>
					<span class="signup-chart__legend-label">{s.label}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.signup-chart {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	/* layerchart's default left padding (20px) clips 4-digit y-axis labels, so
	   the BarChart gets explicit padding with a wider left gutter instead. */
	.signup-chart__plot {
		width: 100%;
		height: 320px;
		min-height: 0;
		overflow: hidden;
	}
	.signup-chart__empty {
		color: var(--color-text-muted);
		text-align: center;
		padding: 4rem 0;
	}
	.signup-chart__total-marker {
		stroke: var(--color-text);
	}
	/* Custom legend rendered below the chart so it never overlaps the bars or
	   x-axis labels (LayerChart's built-in legend is positioned inside the
	   plot area by default). Items wrap onto multiple rows when needed. */
	.signup-chart__legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
		font-size: var(--font-size-sm);
		color: var(--color-text);
	}
	/* Keeps the legend's reserved space while hiding it in overview mode. */
	.signup-chart__legend--hidden {
		visibility: hidden;
	}
	.signup-chart__legend-item {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}
	.signup-chart__swatch {
		display: inline-block;
		width: 12px;
		height: 12px;
		border-radius: 9999px;
		flex-shrink: 0;
	}
	.signup-chart__legend-label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
