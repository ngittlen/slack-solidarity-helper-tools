<script lang="ts">
	// Every VAN campaign, each linking to its own settings page — where its
	// folders, spreadsheets, switches and status live
	// (specs/012-multi-van-campaigns). Read-only here: nothing about a campaign
	// is edited from the list.
	//
	// There is no "add" button. A campaign exists because its credentials do:
	// someone sets a `VAN_CAMPAIGN_<KEY>` secret, and the next sync adds it here,
	// switched off, ready to set up. The note below says so.

	import { resolve } from '$app/paths';
	import { formatRelative } from './format-relative.js';
	import type { CampaignListRow } from '$lib/van/campaign-list.js';

	interface Props {
		campaigns: CampaignListRow[];
	}

	let { campaigns }: Props = $props();

	/** The command, as a string: its braces would otherwise be Svelte. */
	const ADD_EXAMPLE = `fly secrets set VAN_CAMPAIGN_<KEY>='{"appName":"…","apiKey":"…","databaseMode":0}'`;

	const chipLabel = { enabled: 'Enabled', disabled: 'Disabled', new: 'New: not enabled' } as const;

	function healthLabel(row: CampaignListRow): string {
		switch (row.health) {
			case 'no-credentials':
				return 'Credentials missing';
			case 'bad-credentials':
				return 'Credentials invalid';
			case 'failing':
				return 'Sync failing';
			case 'never':
				return 'Never synced';
			case 'ok':
				return row.lastSyncAt
					? `Synced ${formatRelative(Date.now() - Date.parse(row.lastSyncAt))}`
					: 'Synced';
		}
	}
</script>

{#if campaigns.length === 0}
	<p class="empty">No VAN campaigns yet.</p>
{:else}
	<ul class="campaigns">
		{#each campaigns as row (row.id)}
			<li>
				<a
					class="name"
					href={resolve('/settings/van/[campaignId]', { campaignId: String(row.id) })}
				>
					{row.name}
				</a>
				<span class={['chip', row.chip]}>{chipLabel[row.chip]}</span>
				<span class={['health', row.health]} title={row.detail ?? undefined}>
					<span class="dot" aria-hidden="true"></span>
					{healthLabel(row)}
				</span>
				<span class="turfs">{row.liveTurfs} live turf</span>
			</li>
		{/each}
	</ul>
{/if}

<p class="note">
	To add a campaign, set its credentials as a Fly secret — <code>{ADD_EXAMPLE}</code>
	— and it appears here, switched off, after the next sync. The <code>&lt;KEY&gt;</code> is its permanent
	id: renaming the secret makes a new campaign. See the README for the format.
</p>

<style>
	.campaigns {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	.campaigns li {
		display: grid;
		grid-template-columns: minmax(10rem, 1fr) auto auto auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.name {
		font-weight: 600;
	}

	.chip {
		font-size: var(--font-size-sm);
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		white-space: nowrap;
	}

	.chip.enabled {
		border-color: var(--color-success);
	}

	.chip.new {
		font-style: italic;
	}

	.health {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--font-size-sm);
		white-space: nowrap;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-text-muted);
	}

	.health.ok .dot {
		background: var(--color-success);
	}

	.health.failing .dot,
	.health.no-credentials .dot,
	.health.bad-credentials .dot {
		background: var(--color-error);
	}

	.turfs {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.empty,
	.note {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.note {
		margin-top: var(--space-3);
	}

	@media (max-width: 640px) {
		.campaigns li {
			grid-template-columns: 1fr auto;
		}
	}
</style>
