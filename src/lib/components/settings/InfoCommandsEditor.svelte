<script lang="ts">
	import { errMessage } from '$lib/err-message.js';
	import { INFO_MESSAGE_MAX_LENGTH, validateCommandName } from '$lib/info-command.js';
	import DeleteConfirmButton from './DeleteConfirmButton.svelte';

	/** Mirrors InfoCommandEntry from $lib/server/settings.ts. */
	interface InfoCommand {
		command: string;
		message: string;
	}

	interface Props {
		commands: InfoCommand[];
	}

	let { commands }: Props = $props();

	// Each row keeps the name it was last saved under. That's what identifies
	// the row server-side (the command name is the primary key), so a rename is
	// "save the new one, delete the old one" and needs both values.
	interface Row {
		/** '' for a row that has never been saved. */
		saved: string;
		command: string;
		message: string;
		status: 'idle' | 'saving' | 'saved' | 'error';
		error: string | null;
	}

	let rows = $state<Row[]>(
		commands.map((c) => ({
			saved: c.command,
			command: c.command,
			message: c.message,
			status: 'idle' as const,
			error: null,
		})),
	);

	const dirty = (row: Row) =>
		row.saved === '' || row.command !== row.saved || row.message !== savedMessage(row.saved);

	// The message as last confirmed by the server, so the Save button can go
	// quiet once a row matches what is stored.
	let savedMessages = $state<Record<string, string>>(
		Object.fromEntries(commands.map((c) => [c.command, c.message])),
	);
	const savedMessage = (command: string) => savedMessages[command] ?? '';

	const withoutKey = (record: Record<string, string>, key: string) =>
		Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

	function addRow(): void {
		rows = [...rows, { saved: '', command: '', message: '', status: 'idle', error: null }];
	}

	async function save(index: number): Promise<void> {
		const row = rows[index];
		if (!row) return;

		// Checked client-side first purely for the faster message; the endpoint
		// validates the same rules and is the one that decides.
		const nameCheck = validateCommandName(row.command);
		if (!nameCheck.ok) {
			row.status = 'error';
			row.error = nameCheck.error;
			return;
		}
		if (row.message.trim() === '') {
			row.status = 'error';
			row.error = 'Enter the message this command should post.';
			return;
		}

		row.status = 'saving';
		row.error = null;

		try {
			const res = await fetch('/api/settings/info-commands', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'save',
					command: nameCheck.command,
					message: row.message,
					previousCommand: row.saved,
				}),
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(payload.error ?? `Save failed (${res.status})`);
			}

			// Drop the old key on a rename so `dirty` compares against the right
			// stored message afterwards.
			if (row.saved !== '' && row.saved !== nameCheck.command) {
				savedMessages = withoutKey(savedMessages, row.saved);
			}
			savedMessages = { ...savedMessages, [nameCheck.command]: row.message.trim() };
			row.command = nameCheck.command;
			row.message = row.message.trim();
			row.saved = nameCheck.command;
			row.status = 'saved';
		} catch (err) {
			row.status = 'error';
			row.error = errMessage(err);
		}
	}

	async function remove(index: number): Promise<void> {
		const row = rows[index];
		if (!row) return;

		// A row that was never saved has nothing to delete server-side.
		if (row.saved === '') {
			rows = rows.filter((_, i) => i !== index);
			return;
		}

		row.status = 'saving';
		row.error = null;
		try {
			const res = await fetch('/api/settings/info-commands', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'delete', command: row.saved }),
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(payload.error ?? `Delete failed (${res.status})`);
			}
			savedMessages = withoutKey(savedMessages, row.saved);
			rows = rows.filter((_, i) => i !== index);
		} catch (err) {
			row.status = 'error';
			row.error = errMessage(err);
		}
	}
</script>

<div class="info-commands">
	<p class="intro">
		Slash commands that post a set message <strong>as you</strong> — not as the bot — in whatever
		channel you run them in. Useful for the answers you retype constantly, like where to sign up to
		phone bank. Write channels as <code>#channel-name</code> and they become real links when posted.
	</p>

	<p class="warn">
		Adding a command here is only half of it: Slack won't send a command it doesn't know about. For
		each one, add a matching slash command in your Slack app config at
		<a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a>
		pointing at <code>/api/slack/commands</code>. Until you do, the command does nothing in Slack.
	</p>

	{#if rows.length === 0}
		<p class="empty">No commands yet.</p>
	{/if}

	<ul class="rows">
		{#each rows as row, i (i)}
			<li class="row" data-status={row.status}>
				<div class="fields">
					<label class="field name">
						<span class="label">Command</span>
						<input
							type="text"
							bind:value={row.command}
							placeholder="/info-phone"
							spellcheck="false"
							autocapitalize="off"
							autocorrect="off"
						/>
					</label>

					<label class="field message">
						<span class="label">Message</span>
						<textarea
							bind:value={row.message}
							rows="3"
							maxlength={INFO_MESSAGE_MAX_LENGTH}
							placeholder="You can get right to helping the campaign by signing up to phone or text bank here: #phone-bank #text-bank"
						></textarea>
					</label>
				</div>

				<div class="actions">
					<button
						type="button"
						class="save"
						disabled={row.status === 'saving' || !dirty(row)}
						onclick={() => save(i)}
					>
						{row.status === 'saving' ? 'Saving…' : 'Save'}
					</button>
					<DeleteConfirmButton
						label={row.saved ? `Delete ${row.saved}` : 'Delete'}
						description="This only removes the message. The slash command itself stays registered in your Slack app config until you delete it there too."
						onConfirm={() => remove(i)}
						disabled={row.status === 'saving'}
					/>
					{#if row.status === 'saved' && !dirty(row)}
						<span class="status saved" aria-live="polite">Saved</span>
					{/if}
				</div>

				{#if row.status === 'error' && row.error}
					<p class="error" role="alert">{row.error}</p>
				{/if}
			</li>
		{/each}
	</ul>

	<button type="button" class="add" onclick={addRow}>Add command</button>
</div>

<style>
	.info-commands {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.intro,
	.warn,
	.empty {
		margin: 0;
		font-size: 0.9em;
		color: var(--color-text-muted);
	}

	.warn {
		border-left: 3px solid var(--color-warning);
		padding-left: 10px;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.row {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
	}

	.row[data-status='error'] {
		border-color: var(--color-error);
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.label {
		font-weight: 600;
		font-size: 0.85em;
	}

	input,
	textarea {
		font: inherit;
		padding: 6px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface);
		color: var(--color-text);
		width: 100%;
		box-sizing: border-box;
	}

	textarea {
		resize: vertical;
		min-height: 4.5em;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	button {
		font: inherit;
		font-size: 0.9em;
		padding: 4px 12px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text);
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.add {
		align-self: flex-start;
	}

	.status.saved {
		font-size: 0.85em;
		color: var(--color-success);
	}

	.error {
		margin: 0;
		font-size: 0.9em;
		color: var(--color-error);
	}
</style>
