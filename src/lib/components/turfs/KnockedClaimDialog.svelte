<script lang="ts">
	// Asked before checking out turf knocked before its cut. A re-cut that did
	// not leave out the knocked doors lists them as untouched, so MiniVAN sends
	// the volunteer back to some of them. That is theirs to weigh, not ours to
	// refuse: they agree and the claim goes ahead, or go back to the list.
	import { AlertDialog } from 'bits-ui';
	import { KNOCKED_CLAIM_WARNING } from '$lib/van/checkout.js';

	interface Props {
		/** The turf being asked about; the dialog is open while this is set. */
		turfName: string | null;
		onconfirm: () => void;
		oncancel: () => void;
	}

	const { turfName, onconfirm, oncancel }: Props = $props();
</script>

<AlertDialog.Root
	open={turfName !== null}
	onOpenChange={(open) => {
		if (!open) oncancel();
	}}
>
	<AlertDialog.Portal>
		<AlertDialog.Overlay class="knocked-claim-overlay" />
		<AlertDialog.Content class="knocked-claim-content">
			<AlertDialog.Title class="knocked-claim-title">
				{turfName ? `${turfName} was knocked before` : 'Knocked before'}
			</AlertDialog.Title>
			<AlertDialog.Description class="knocked-claim-description">
				{KNOCKED_CLAIM_WARNING}
			</AlertDialog.Description>
			<div class="knocked-claim-actions">
				<AlertDialog.Action class="claim-btn" onclick={onconfirm}>
					Check out this turf
				</AlertDialog.Action>
				<AlertDialog.Cancel class="ghost-btn">Pick another turf</AlertDialog.Cancel>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>

<style>
	:global(.knocked-claim-overlay) {
		position: fixed;
		inset: 0;
		background: var(--color-scrim);
		z-index: 100;
	}

	:global(.knocked-claim-content) {
		position: fixed;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: min(420px, calc(100vw - 32px));
		background: var(--color-bg-surface);
		border-radius: var(--radius-md);
		padding: 20px 24px;
		box-shadow: var(--shadow-modal);
		z-index: 101;
	}

	:global(.knocked-claim-title) {
		margin: 0 0 8px;
		font-size: 1.05em;
		font-weight: 600;
	}

	:global(.knocked-claim-description) {
		margin: 0 0 16px;
		color: var(--color-text);
	}

	.knocked-claim-actions {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
