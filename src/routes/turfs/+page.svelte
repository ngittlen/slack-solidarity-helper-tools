<script lang="ts">
	// Two pages at one URL: the volunteer turf checkout for a signed-in viewer,
	// and a teaser for everyone else. The load function decides which, and
	// ships only that branch's data — see +page.server.ts.

	import PublicTurfTeaser from '$lib/components/turfs/PublicTurfTeaser.svelte';
	import MemberTurfs from './MemberTurfs.svelte';

	const { data, form } = $props();
</script>

{#if data.mode === 'public'}
	<PublicTurfTeaser
		tiles={data.tiles}
		turfCentre={data.turfCentre}
		joinUrl={data.joinUrl}
		signInHref={data.signInHref}
		nearby={form && 'nearby' in form ? (form.nearby ?? null) : null}
		error={form && 'error' in form ? (form.error ?? null) : null}
	/>
{:else}
	<MemberTurfs {data} />
{/if}
