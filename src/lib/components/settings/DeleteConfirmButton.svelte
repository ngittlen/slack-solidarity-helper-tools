<script lang="ts">
	// A "remove this" button that asks first. The confirm dialog itself is
	// ConfirmButton; this keeps the destructive styling its callers rely on.
	import ConfirmButton from './ConfirmButton.svelte';

	interface Props {
		label: string;
		description: string;
		onConfirm: () => Promise<void> | void;
		disabled?: boolean;
	}

	let { label, description, onConfirm, disabled = false }: Props = $props();
</script>

<ConfirmButton {label} {description} {onConfirm} {disabled} tone="danger" />
