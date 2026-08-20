<script lang="ts">
	// Who is blocked from turf checkout. A near-copy of AllowedUsersEditor by
	// design — an organizer who has used the admin list should need no
	// explanation for this one — with two deliberate differences:
	//
	//   1. The picker is NOT filtered to admins. This list is for ordinary
	//      members, and admins can't be blocked at all (the endpoint refuses).
	//   2. Blocking has side effects worth reporting. It frees any turf the
	//      person is holding and ends their sessions, so the confirmation says
	//      what actually happened rather than a bare "saved".

	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import MultiSelectAutocomplete from './MultiSelectAutocomplete.svelte';
	import type { PickerItem } from './picker-types.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	/** Mirrors UserEntry from $lib/server/autocomplete-sources.ts. */
	interface UserOption {
		id: string;
		name: string;
		realName: string;
	}

	interface Props {
		users: UserOption[];
		/** Currently blocked Slack ids, from loadVanBlockedUsers. */
		blockedIds: string[];
	}

	let { users, blockedIds }: Props = $props();

	let blocked = $state<string[]>([...blockedIds]);

	const userItems = $derived<PickerItem<string>[]>(
		users.map((u) => ({
			id: u.id,
			label: u.name,
			sublabel: u.realName && u.realName !== u.name ? u.realName : undefined,
		})),
	);

	interface Op {
		action: 'block' | 'unblock';
		userId: string;
	}

	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let lastFailedOp: Op | null = $state(null);
	let inflight = 0;
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleDismiss(): void {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
			notice = null;
		}, 6000);
	}

	function applyLocal(op: Op): boolean {
		if (op.action === 'block') {
			if (blocked.includes(op.userId)) return false;
			blocked = [...blocked, op.userId];
			return true;
		}
		if (!blocked.includes(op.userId)) return false;
		blocked = blocked.filter((id) => id !== op.userId);
		return true;
	}

	function revertLocal(op: Op): void {
		if (op.action === 'block') {
			blocked = blocked.filter((id) => id !== op.userId);
		} else if (!blocked.includes(op.userId)) {
			blocked = [...blocked, op.userId];
		}
	}

	async function runOp(op: Op): Promise<void> {
		const changed = applyLocal(op);
		status = 'saving';
		error = null;
		notice = null;
		inflight++;
		try {
			const res = await fetch('/api/settings/van-blocklist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(op),
			});
			const parsed = (await res.json().catch(() => null)) as {
				error?: string;
				releasedTurfs?: number;
				sessionsRevoked?: number;
			} | null;
			if (!res.ok) {
				throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
			}
			lastFailedOp = null;
			// Only worth saying when turf actually changed hands — "freed 0 turfs"
			// is noise.
			if (op.action === 'block' && (parsed?.releasedTurfs ?? 0) > 0) {
				const n = parsed?.releasedTurfs ?? 0;
				notice = `Freed ${n} turf${n === 1 ? '' : 's'} they were holding.`;
			}
			if (--inflight === 0 && status === 'saving') {
				status = 'saved';
				scheduleDismiss();
			}
		} catch (e) {
			inflight--;
			if (changed) revertLocal(op);
			status = 'error';
			error = errMessage(e);
			lastFailedOp = op;
		}
	}

	function retry(): void {
		if (!lastFailedOp) return;
		void runOp(lastFailedOp);
	}
</script>

<div class="van-blocklist-editor">
	<SettingsRow
		label="Blocked from turf checkout"
		{status}
		{error}
		onRetry={lastFailedOp ? retry : undefined}
	>
		<MultiSelectAutocomplete
			items={userItems}
			values={blocked}
			onAdd={(id) => void runOp({ action: 'block', userId: id })}
			onRemove={(id) => void runOp({ action: 'unblock', userId: id })}
			placeholder="Block someone…"
			showSublabel={true}
			minChars={3}
		/>
		{#if notice}
			<p class="van-blocklist-notice" role="status">{notice}</p>
		{/if}
		<p class="van-blocklist-note">
			Blocked members can’t see the turf map or claim turf. Blocking takes effect immediately — it
			releases any turf they’re holding and signs them out. Admins and the
			<code>SLACK_SUPERUSER_ID</code> user can’t be blocked. Unblocking does not give their turf back,
			since someone else may have claimed it.
		</p>
	</SettingsRow>
</div>

<style>
	.van-blocklist-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.van-blocklist-note {
		color: var(--color-text-muted, #888);
		font-size: 0.9em;
		margin: 8px 0 0;
	}

	.van-blocklist-note code {
		font-size: 0.95em;
	}

	.van-blocklist-notice {
		margin: 8px 0 0;
		font-size: 0.9em;
		color: var(--color-text);
		background: var(--color-cream-light);
		border-left: 3px solid var(--color-warning);
		border-radius: var(--radius-sm);
		padding: 6px 10px;
	}
</style>
