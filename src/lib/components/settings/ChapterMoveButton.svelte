<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { errMessage } from '$lib/err-message.js';
	import type { ChapterMovePlan, ChapterMoveTarget } from '$lib/server/chapter-reconcile';

	interface ChannelOption {
		id: string;
		name: string;
		isPrivate: boolean;
	}

	interface Props {
		/** Live channel list, for resolving channel names in the plan. */
		channels: ChannelOption[];
	}

	let { channels }: Props = $props();

	interface MoveResult {
		channelId: string;
		slackUserId: string;
		email: string;
		ok: boolean;
		error?: string;
	}

	type Phase =
		| { kind: 'loading' }
		| { kind: 'error'; message: string }
		| { kind: 'plan'; plan: ChapterMovePlan }
		| { kind: 'applying'; total: number }
		| { kind: 'done'; results: MoveResult[] };

	let open = $state(false);
	let phase = $state<Phase>({ kind: 'loading' });

	function channelName(id: string): string {
		const hit = channels.find((c) => c.id === id);
		return hit ? `#${hit.name}` : id;
	}

	const totalToInvite = $derived(
		phase.kind === 'plan'
			? phase.plan.channels.reduce((sum, ch) => sum + ch.toInvite.length, 0)
			: 0,
	);

	async function loadPlan(): Promise<void> {
		phase = { kind: 'loading' };
		try {
			const res = await fetch('/api/settings/chapter-channels/reconcile');
			const body = (await res.json().catch(() => null)) as
				(ChapterMovePlan & { error?: string }) | null;
			if (!res.ok || !body) {
				throw new Error(body?.error ?? `Failed to load plan (HTTP ${res.status})`);
			}
			phase = { kind: 'plan', plan: body };
		} catch (e) {
			phase = { kind: 'error', message: errMessage(e) };
		}
	}

	function handleOpenChange(next: boolean): void {
		open = next;
		if (next) void loadPlan();
	}

	async function applyPlan(plan: ChapterMovePlan): Promise<void> {
		const targets = plan.channels.flatMap((ch) =>
			ch.toInvite.map((p: ChapterMoveTarget) => ({
				channelId: ch.channelId,
				slackUserId: p.slackUserId,
				email: p.email,
			})),
		);
		phase = { kind: 'applying', total: targets.length };
		try {
			const res = await fetch('/api/settings/chapter-channels/reconcile', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ targets }),
			});
			const body = (await res.json().catch(() => null)) as {
				results?: MoveResult[];
				error?: string;
			} | null;
			if (!res.ok || !body?.results) {
				throw new Error(body?.error ?? `Move failed (HTTP ${res.status})`);
			}
			phase = { kind: 'done', results: body.results };
		} catch (e) {
			phase = { kind: 'error', message: errMessage(e) };
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Trigger class="move-trigger">Move members into mapped channels…</Dialog.Trigger>
	<Dialog.Portal>
		<Dialog.Overlay class="move-overlay" />
		<Dialog.Content class="move-content">
			<Dialog.Title class="move-title">Move members into mapped channels</Dialog.Title>
			<Dialog.Description class="move-description">
				Invites every Slack member into the channels their Solidarity chapters map to. Nobody is
				removed from any channel.
			</Dialog.Description>

			{#if phase.kind === 'loading'}
				<div class="move-loading" role="status">
					<span class="move-spinner" aria-hidden="true"></span>
					<p class="move-status">
						Working out who needs to move — comparing Solidarity chapters, Slack members, and
						channel rosters…
					</p>
				</div>
			{:else if phase.kind === 'error'}
				<p class="move-error" role="alert">{phase.message}</p>
				<div class="move-actions">
					<button type="button" class="move-secondary" onclick={() => void loadPlan()}>
						Try again
					</button>
					<Dialog.Close class="move-secondary">Close</Dialog.Close>
				</div>
			{:else if phase.kind === 'plan'}
				{@const plan = phase.plan}
				<p class="move-summary">
					{#if totalToInvite === 0}
						Everyone is already in their mapped channels — there's nobody to move.
					{:else}
						<strong>{totalToInvite}</strong>
						{totalToInvite === 1 ? 'person' : 'people'} will be invited across
						<strong>{plan.channels.length}</strong>
						{plan.channels.length === 1 ? 'channel' : 'channels'}.
					{/if}
					<span class="move-counts">
						{plan.alreadyInPlaceCount} already in place ·
						{plan.notInSlackCount} not in Slack ·
						{plan.unmappedChaptersCount} in unmapped chapters
					</span>
				</p>
				{#if totalToInvite > 0}
					<div class="move-plan">
						{#each plan.channels as ch (ch.channelId)}
							<section class="move-channel">
								<h4 class="move-channel-name">
									{channelName(ch.channelId)}
									<span class="move-channel-count">
										{ch.toInvite.length} to invite
									</span>
								</h4>
								<ul class="move-people">
									{#each ch.toInvite as person (person.slackUserId)}
										<li>
											<span class="move-person-name">{person.name}</span>
											<span class="move-person-meta">
												{person.email} · {person.chapterNames.join(', ')}
											</span>
										</li>
									{/each}
								</ul>
							</section>
						{/each}
					</div>
				{/if}
				<div class="move-actions">
					<Dialog.Close class="move-secondary">Cancel</Dialog.Close>
					{#if totalToInvite > 0}
						<button type="button" class="move-primary" onclick={() => void applyPlan(plan)}>
							Move {totalToInvite}
							{totalToInvite === 1 ? 'person' : 'people'}
						</button>
					{/if}
				</div>
			{:else if phase.kind === 'applying'}
				<div class="move-loading" role="status">
					<span class="move-spinner" aria-hidden="true"></span>
					<p class="move-status">
						Inviting {phase.total}
						{phase.total === 1 ? 'person' : 'people'}…
					</p>
				</div>
			{:else if phase.kind === 'done'}
				{@const failed = phase.results.filter((r) => !r.ok)}
				{@const okCount = phase.results.length - failed.length}
				<p class="move-summary">
					Moved <strong>{okCount}</strong> of {phase.results.length}
					{phase.results.length === 1 ? 'invite' : 'invites'}.
				</p>
				{#if failed.length > 0}
					<div class="move-plan">
						<h4 class="move-channel-name">Failed</h4>
						<ul class="move-people">
							{#each failed as r (r.channelId + r.slackUserId)}
								<li>
									<span class="move-person-name">{r.email || r.slackUserId}</span>
									<span class="move-person-meta move-error-text">
										{channelName(r.channelId)} · {r.error}
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				<div class="move-actions">
					<Dialog.Close class="move-primary">Close</Dialog.Close>
				</div>
			{/if}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.move-trigger) {
		background: transparent;
		color: var(--color-gold);
		border: 1px solid currentColor;
		border-radius: var(--radius-sm);
		padding: 5px 12px;
		font: inherit;
		font-size: 0.9em;
		cursor: pointer;
	}

	:global(.move-trigger:hover) {
		background: color-mix(in srgb, var(--color-gold) 8%, transparent);
	}

	:global(.move-overlay) {
		position: fixed;
		inset: 0;
		background: var(--color-scrim);
		z-index: 100;
	}

	:global(.move-content) {
		position: fixed;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		background: var(--color-bg-surface);
		border-radius: var(--radius-md);
		padding: 20px 24px;
		width: min(640px, 92vw);
		max-height: 84vh;
		display: flex;
		flex-direction: column;
		box-shadow: var(--shadow-modal);
		z-index: 101;
	}

	:global(.move-title) {
		margin: 0 0 4px;
		font-size: 1.05em;
		font-weight: 600;
	}

	:global(.move-description) {
		margin: 0 0 12px;
		font-size: 0.9em;
		color: var(--color-text-muted);
	}

	.move-loading {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 16px 0;
	}

	.move-spinner {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border: 3px solid var(--color-border);
		border-top-color: var(--color-gold);
		border-radius: 50%;
		animation: move-spin 0.8s linear infinite;
	}

	@keyframes move-spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Motion-sensitive users still get a "working" cue, just not a spinning one. */
	@media (prefers-reduced-motion: reduce) {
		.move-spinner {
			animation: move-spin 2.4s steps(8) infinite;
		}
	}

	.move-status {
		margin: 12px 0;
		color: var(--color-text-muted);
	}

	.move-summary {
		margin: 0 0 10px;
	}

	.move-counts {
		display: block;
		margin-top: 4px;
		font-size: 0.85em;
		color: var(--color-text-muted);
	}

	.move-plan {
		overflow-y: auto;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 8px 12px;
		margin-bottom: 12px;
	}

	.move-channel + .move-channel {
		margin-top: 12px;
		border-top: 1px solid var(--color-border);
		padding-top: 10px;
	}

	.move-channel-name {
		margin: 0 0 6px;
		font-size: 0.95em;
	}

	.move-channel-count {
		font-weight: 400;
		font-size: 0.85em;
		color: var(--color-text-muted);
		margin-left: 6px;
	}

	.move-people {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.move-person-name {
		margin-right: 6px;
	}

	.move-person-meta {
		font-size: 0.85em;
		color: var(--color-text-muted);
	}

	.move-error {
		margin: 12px 0;
		color: var(--color-error);
	}

	.move-error-text {
		color: var(--color-error);
	}

	.move-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: auto;
		padding-top: 4px;
	}

	:global(.move-secondary) {
		background: transparent;
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 5px 14px;
		font: inherit;
		cursor: pointer;
	}

	:global(.move-primary) {
		background: var(--color-gold);
		color: var(--color-action-text);
		border: 1px solid var(--color-gold);
		border-radius: var(--radius-sm);
		padding: 5px 14px;
		font: inherit;
		cursor: pointer;
	}
</style>
