<script lang="ts">
	// Admins only: try the mentor flow on yourself (specs/015-mentor-walks).
	// "Start over" forgets your mentor status and has this session count as
	// eligible and see the feature whatever the setting, so the invitation, the
	// guidelines agreement and the walk form all run for real. Nobody else sees
	// any of it, unless the setting shows them your walks.

	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import '$lib/components/mentor-walks/mentor-walks.css';
	import { MENTOR_WALKS_VISIBILITY_LABELS } from '$lib/mentor-walks/rules.js';
	import type { MentorDebugView } from '$lib/mentor-walks/types.js';

	interface Props {
		debug: MentorDebugView;
		/** The page's own query, so a reload lands back on the same chapter. */
		pageQuery: string;
	}

	let { debug, pageQuery }: Props = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);

	async function post(action: 'mentorDebugStart' | 'mentorDebugStop') {
		busy = true;
		error = null;
		try {
			const res = await fetch(`?/${action}${pageQuery ? `&${pageQuery}` : ''}`, {
				method: 'POST',
				body: new FormData(),
				headers: { 'x-sveltekit-action': 'true' },
			});
			const result = deserialize(await res.text());
			if (result.type === 'success') await invalidateAll();
			else if (result.type === 'failure' && typeof result.data?.mentorError === 'string') {
				error = result.data.mentorError;
			} else error = 'Something went wrong. Please try again.';
		} catch {
			error = 'Something went wrong. Please try again.';
		} finally {
			busy = false;
		}
	}
</script>

<details class="mentor-debug" open={debug.simulating}>
	<summary>
		Mentor walks debug <span class="mw-muted">· admins only</span>
		{#if debug.simulating}<span class="mw-chip mw-chip-warning">Simulating</span>{/if}
	</summary>
	<dl>
		<dt>Your mentor status</dt>
		<dd>{debug.status}</dd>
		<dt>Your real record</dt>
		<dd>{debug.completed} completed turfs, {debug.doors} doors</dd>
		<dt>Mentor walks setting</dt>
		<dd>{MENTOR_WALKS_VISIBILITY_LABELS[debug.visibility]}</dd>
	</dl>
	{#if !debug.guidelinesSet}
		<p class="mw-error">
			Set the volunteer guidelines link in Settings first. Without it nobody is invited, including
			you.
		</p>
	{/if}
	<p class="mw-muted">
		Start over to see the invitation as an eligible volunteer would, agree to the guidelines and
		post a walk. It forgets your mentor status and cancels your upcoming walks. While simulating you
		see mentor walks whatever the setting says; nobody else does.
	</p>
	<div class="mw-actions">
		<button
			type="button"
			class="mw-btn mw-btn-primary"
			disabled={busy}
			onclick={() => post('mentorDebugStart')}
		>
			{debug.simulating ? 'Start over again' : 'Start over as an eligible volunteer'}
		</button>
		{#if debug.simulating}
			<button
				type="button"
				class="mw-btn mw-btn-ghost"
				disabled={busy}
				onclick={() => post('mentorDebugStop')}
			>
				Stop simulating
			</button>
		{/if}
	</div>
	{#if error}
		<p class="mw-error" role="alert">{error}</p>
	{/if}
</details>

<style>
	.mentor-debug {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-alt);
		font-size: var(--font-size-sm);
	}

	summary {
		cursor: pointer;
		font-weight: 600;
	}

	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-1) var(--space-3);
		margin: var(--space-2) 0;
	}

	dt {
		color: var(--color-text-muted);
	}

	dd {
		margin: 0;
	}

	p {
		margin: 0 0 var(--space-2);
	}
</style>
