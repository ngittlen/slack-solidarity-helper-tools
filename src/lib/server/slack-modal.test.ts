import { describe, it, expect } from 'vitest';
import {
	buildNoteModal,
	extractNoteSubmission,
	prefillFromView,
	readModalMetadata,
	parseCommandTarget,
	BLOCK,
	NOTE_MODAL_CALLBACK_ID,
	MAX_BODY_LENGTH,
} from './slack-modal.js';

const OPTS = { channelId: 'C0CHAN', warningTemplate: 'This is your {{nth}} warning.' };

const blockIds = (view: ReturnType<typeof buildNoteModal>) => view.blocks.map((b) => b.block_id);
const block = (view: ReturnType<typeof buildNoteModal>, id: string) =>
	view.blocks.find((b) => b.block_id === id);

describe('buildNoteModal', () => {
	it('emits the expected blocks for a note', () => {
		const view = buildNoteModal({}, OPTS);
		expect(view.callback_id).toBe(NOTE_MODAL_CALLBACK_ID);
		expect(blockIds(view)).toEqual([BLOCK.member, BLOCK.kind, BLOCK.body, BLOCK.link]);
	});

	it('shows the warning-text box only when Warning is selected', () => {
		expect(blockIds(buildNoteModal({ kind: 'note' }, OPTS))).not.toContain(BLOCK.warningText);
		expect(blockIds(buildNoteModal({ kind: 'warning' }, OPTS))).toContain(BLOCK.warningText);
	});

	// Only warnings DM the member, so the control has no meaning on a note.
	it('shows the Notify checkbox only when Warning is selected', () => {
		expect(blockIds(buildNoteModal({ kind: 'note' }, OPTS))).not.toContain(BLOCK.dm);
		expect(blockIds(buildNoteModal({ kind: 'warning' }, OPTS))).toContain(BLOCK.dm);
	});

	it('seeds the warning box with the configured template, tokens intact', () => {
		const view = buildNoteModal({ kind: 'warning' }, OPTS);
		expect(block(view, BLOCK.warningText)!.element['initial_value']).toBe(
			'This is your {{nth}} warning.',
		);
	});

	it('prefers an already-edited warning text over the template', () => {
		const view = buildNoteModal({ kind: 'warning', warningText: 'Custom text' }, OPTS);
		expect(block(view, BLOCK.warningText)!.element['initial_value']).toBe('Custom text');
	});

	it('marks the warning-message box optional', () => {
		expect(block(buildNoteModal({ kind: 'warning' }, OPTS), BLOCK.warningText)!.optional).toBe(
			true,
		);
	});

	it('tells the admin what a blank warning message does', () => {
		const hint = block(buildNoteModal({ kind: 'warning' }, OPTS), BLOCK.warningText)!.hint!.text;
		expect(hint).toContain('Leave blank');
		expect(hint).toContain('Settings');
	});

	it('sets dispatch_action on the kind block so the radio round-trips', () => {
		expect(block(buildNoteModal({}, OPTS), BLOCK.kind)!.dispatch_action).toBe(true);
	});

	// An unchecked checkboxes element submits nothing; a required block would
	// then reject the whole submission.
	it('marks the DM block optional', () => {
		expect(block(buildNoteModal({ kind: 'warning' }, OPTS), BLOCK.dm)!.optional).toBe(true);
	});

	it('checks the DM box by default', () => {
		expect(
			block(buildNoteModal({ kind: 'warning' }, OPTS), BLOCK.dm)!.element['initial_options'],
		).toHaveLength(1);
	});

	it('leaves the DM box unchecked when the prefill says so', () => {
		expect(
			block(buildNoteModal({ kind: 'warning', sendDm: false }, OPTS), BLOCK.dm)!.element[
				'initial_options'
			],
		).toBeUndefined();
	});

	it('marks the link block optional and omits initial_value when absent', () => {
		const linkBlock = block(buildNoteModal({}, OPTS), BLOCK.link)!;
		expect(linkBlock.optional).toBe(true);
		expect(linkBlock.element['initial_value']).toBeUndefined();
	});

	it('prefills the member and the message link (the shortcut path)', () => {
		const view = buildNoteModal(
			{ slackUserId: 'U0ABC', messageLink: 'https://w.slack.com/archives/C1/p1712345678123456' },
			OPTS,
		);
		expect(block(view, BLOCK.member)!.element['initial_user']).toBe('U0ABC');
		expect(block(view, BLOCK.link)!.element['initial_value']).toBe(
			'https://w.slack.com/archives/C1/p1712345678123456',
		);
	});

	it('omits initial_user when no member is prefilled', () => {
		expect(block(buildNoteModal({}, OPTS), BLOCK.member)!.element['initial_user']).toBeUndefined();
	});

	it('carries the channel id through private_metadata', () => {
		expect(JSON.parse(buildNoteModal({}, OPTS).private_metadata)).toEqual({
			channelId: 'C0CHAN',
			source: 'slash',
		});
	});

	it('carries the entry point through private_metadata', () => {
		expect(
			JSON.parse(buildNoteModal({}, { ...OPTS, source: 'shortcut' }).private_metadata).source,
		).toBe('shortcut');
	});
});

// --- Payload helpers -------------------------------------------------------

function view(over: Record<string, unknown> = {}) {
	return {
		view: {
			private_metadata: JSON.stringify({ channelId: 'C0CHAN', source: 'slash' }),
			state: {
				values: {
					[BLOCK.member]: { value: { selected_user: 'U0ABC' } },
					[BLOCK.kind]: { value: { selected_option: { value: 'note' } } },
					[BLOCK.body]: { value: { value: 'Details here' } },
					[BLOCK.link]: { value: { value: '' } },
					[BLOCK.dm]: { value: { selected_options: [] } },
					...over,
				},
			},
		},
	};
}

describe('extractNoteSubmission', () => {
	it('accepts a valid note', () => {
		const result = extractNoteSubmission(view());
		expect(result.ok).toBe(true);
		expect(result.ok && result.submission).toMatchObject({
			slackUserId: 'U0ABC',
			kind: 'note',
			body: 'Details here',
			messageRef: null,
			sendDm: false,
		});
	});

	it('reads a checked DM box', () => {
		const result = extractNoteSubmission(
			view({ [BLOCK.dm]: { value: { selected_options: [{ value: 'send' }] } } }),
		);
		expect(result.ok && result.submission.sendDm).toBe(true);
	});

	it('parses a valid message link', () => {
		const result = extractNoteSubmission(
			view({
				[BLOCK.link]: {
					value: { value: 'https://w.slack.com/archives/C0ABC123/p1712345678123456' },
				},
			}),
		);
		expect(result.ok && result.submission.messageRef).toMatchObject({
			channelId: 'C0ABC123',
			ts: '1712345678.123456',
		});
	});

	it('rejects a link that is not a Slack permalink', () => {
		const result = extractNoteSubmission(
			view({ [BLOCK.link]: { value: { value: 'https://example.com/whatever' } } }),
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && Object.keys(result.errors)).toEqual([BLOCK.link]);
	});

	it('rejects an empty body', () => {
		const result = extractNoteSubmission(view({ [BLOCK.body]: { value: { value: '   ' } } }));
		expect(!result.ok && result.errors[BLOCK.body]).toBeTruthy();
	});

	it('rejects an over-length body', () => {
		const result = extractNoteSubmission(
			view({ [BLOCK.body]: { value: { value: 'x'.repeat(MAX_BODY_LENGTH + 1) } } }),
		);
		expect(!result.ok && result.errors[BLOCK.body]).toBeTruthy();
	});

	it('rejects a missing member', () => {
		const result = extractNoteSubmission(view({ [BLOCK.member]: { value: {} } }));
		expect(!result.ok && result.errors[BLOCK.member]).toBeTruthy();
	});

	// Blank is a meaningful answer — "send what Settings is configured to send" —
	// so it must pass validation and reach the caller as ''.
	it('accepts a warning with a blank warning message', () => {
		const result = extractNoteSubmission(
			view({
				[BLOCK.kind]: { value: { selected_option: { value: 'warning' } } },
				[BLOCK.warningText]: { value: { value: '  ' } },
			}),
		);
		expect(result.ok).toBe(true);
		expect(result.ok === true && result.submission.warningText).toBe('');
	});

	it('accepts a warning with warning text', () => {
		const result = extractNoteSubmission(
			view({
				[BLOCK.kind]: { value: { selected_option: { value: 'warning' } } },
				[BLOCK.warningText]: { value: { value: 'Your {{nth}} warning.' } },
			}),
		);
		expect(result.ok && result.submission.kind).toBe('warning');
		expect(result.ok && result.submission.warningText).toBe('Your {{nth}} warning.');
	});

	it('reports every problem at once so the admin fixes them in one pass', () => {
		const result = extractNoteSubmission(
			view({
				[BLOCK.member]: { value: {} },
				[BLOCK.body]: { value: { value: '' } },
				[BLOCK.link]: { value: { value: 'nonsense' } },
			}),
		);
		expect(!result.ok && Object.keys(result.errors).sort()).toEqual(
			[BLOCK.body, BLOCK.link, BLOCK.member].sort(),
		);
	});

	it('does not throw on a malformed payload', () => {
		for (const payload of [null, undefined, {}, { view: {} }, 'nope']) {
			expect(() => extractNoteSubmission(payload)).not.toThrow();
			expect(extractNoteSubmission(payload).ok).toBe(false);
		}
	});
});

describe('prefillFromView', () => {
	// This is what keeps a views.update from wiping whatever the admin already
	// typed when they flip the Note/Warning radio.
	it('round-trips every field so a views.update preserves typed state', () => {
		const payload = view({
			[BLOCK.kind]: { value: { selected_option: { value: 'warning' } } },
			[BLOCK.body]: { value: { value: 'typed details' } },
			[BLOCK.link]: { value: { value: 'https://w.slack.com/archives/C1/p1712345678123456' } },
			[BLOCK.warningText]: { value: { value: 'edited warning' } },
			[BLOCK.dm]: { value: { selected_options: [{ value: 'send' }] } },
		});

		expect(prefillFromView(payload)).toEqual({
			slackUserId: 'U0ABC',
			kind: 'warning',
			body: 'typed details',
			messageLink: 'https://w.slack.com/archives/C1/p1712345678123456',
			warningText: 'edited warning',
			sendDm: true,
		});
	});

	it('rebuilding from a prefill keeps the typed values in the new view', () => {
		const payload = view({
			[BLOCK.kind]: { value: { selected_option: { value: 'warning' } } },
			[BLOCK.body]: { value: { value: 'typed details' } },
		});
		const rebuilt = buildNoteModal(prefillFromView(payload), OPTS);

		expect(block(rebuilt, BLOCK.body)!.element['initial_value']).toBe('typed details');
		expect(block(rebuilt, BLOCK.member)!.element['initial_user']).toBe('U0ABC');
		expect(blockIds(rebuilt)).toContain(BLOCK.warningText);
	});

	it('seeds the warning box from the template the first time Warning is picked', () => {
		// Toggling to warning: no warning text has been typed yet.
		const payload = view({ [BLOCK.kind]: { value: { selected_option: { value: 'warning' } } } });
		const rebuilt = buildNoteModal(prefillFromView(payload), OPTS);

		expect(block(rebuilt, BLOCK.warningText)!.element['initial_value']).toBe(
			'This is your {{nth}} warning.',
		);
	});

	it('handles an empty view', () => {
		expect(prefillFromView({})).toEqual({
			slackUserId: null,
			kind: 'note',
			body: null,
			messageLink: null,
			warningText: null,
			// undefined, not false — nothing was on screen to read an opinion from.
			sendDm: undefined,
		});
	});

	// Note -> Warning reads a view that never rendered the checkbox. Reporting
	// `false` there would rebuild the modal unchecked and silently suppress a
	// DM the admin never chose to suppress.
	it('does not turn the DM off when toggling from a view that lacked the checkbox', () => {
		const noteView = view({ [BLOCK.kind]: { value: { selected_option: { value: 'warning' } } } });
		// Simulate the note view: no dm block in state at all.
		delete (noteView.view.state.values as Record<string, unknown>)[BLOCK.dm];

		const prefill = prefillFromView(noteView);
		expect(prefill.sendDm).toBeUndefined();

		const rebuilt = buildNoteModal(prefill, OPTS);
		expect(block(rebuilt, BLOCK.dm)!.element['initial_options']).toHaveLength(1);
	});

	it('preserves an explicit uncheck across a rebuild', () => {
		const warningView = view({
			[BLOCK.kind]: { value: { selected_option: { value: 'warning' } } },
			[BLOCK.dm]: { value: { selected_options: [] } },
		});

		const prefill = prefillFromView(warningView);
		expect(prefill.sendDm).toBe(false);

		const rebuilt = buildNoteModal(prefill, OPTS);
		expect(block(rebuilt, BLOCK.dm)!.element['initial_options']).toBeUndefined();
	});
});

describe('readModalMetadata', () => {
	it('reads the channel id and entry point', () => {
		expect(readModalMetadata(view())).toEqual({ channelId: 'C0CHAN', source: 'slash' });
	});

	it.each([
		null,
		{},
		{ view: {} },
		{ view: { private_metadata: '' } },
		{ view: { private_metadata: 'not json' } },
	])('degrades to defaults for %p', (payload) => {
		expect(readModalMetadata(payload)).toEqual({ channelId: null, source: 'slash' });
	});
});

describe('parseCommandTarget', () => {
	it.each([
		['<@U0ABC123|alice>', 'U0ABC123'],
		['<@U0ABC123>', 'U0ABC123'],
		['  <@W0ABC123|bob>  ', 'W0ABC123'],
		['<@u0abc123|alice>', 'U0ABC123'],
	])('extracts an id from %s', (input, expected) => {
		expect(parseCommandTarget(input)).toBe(expected);
	});

	it.each(['', '   ', 'alice', '@alice', 'some free text'])(
		'returns null for unescaped input %p',
		(input) => {
			expect(parseCommandTarget(input)).toBeNull();
		},
	);

	it('does not throw on undefined', () => {
		expect(parseCommandTarget(undefined as unknown as string)).toBeNull();
	});
});
