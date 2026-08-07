import { describe, it, expect } from 'vitest';
import { renderMemberNoteLog } from './member-note-log.js';

const base = {
	kind: 'note' as const,
	body: 'Kept posting off-topic links',
	targetSlackUserId: 'U0TARGET',
	authorSlackUserId: 'U0ADMIN',
	dmBody: null,
};

describe('renderMemberNoteLog', () => {
	it('renders a note', () => {
		expect(renderMemberNoteLog(base)).toBe(
			'Note “Kept posting off-topic links” added to user <@U0TARGET> by <@U0ADMIN>',
		);
	});

	it('renders a warning that was DM’d, including the message sent', () => {
		expect(
			renderMemberNoteLog({
				...base,
				kind: 'warning',
				dmBody: 'This is your first warning.',
			}),
		).toBe(
			'Warning “Kept posting off-topic links” added to user <@U0TARGET> ' +
				'and warning “This is your first warning.” sent to them by <@U0ADMIN>',
		);
	});

	// A warning the member never received must not claim otherwise — this is the
	// suppressed / failed-DM case.
	it('omits the sent clause for a warning with no DM', () => {
		const out = renderMemberNoteLog({ ...base, kind: 'warning', dmBody: null });
		expect(out).toBe(
			'Warning “Kept posting off-topic links” added to user <@U0TARGET> by <@U0ADMIN>',
		);
		expect(out).not.toContain('sent to them');
	});

	it('collapses a multi-line note onto one line', () => {
		expect(renderMemberNoteLog({ ...base, body: 'line one\n\nline two   with   gaps' })).toContain(
			'“line one line two with gaps”',
		);
	});

	it('collapses a multi-line DM body too', () => {
		expect(
			renderMemberNoteLog({
				...base,
				kind: 'warning',
				dmBody: 'This is your first warning.\n\n> quoted note\n\nPlease stop.',
			}),
		).toContain('“This is your first warning. > quoted note Please stop.”');
	});

	it('trims surrounding whitespace', () => {
		expect(renderMemberNoteLog({ ...base, body: '   padded   ' })).toContain('“padded”');
	});

	it('mentions both users so the channel renders real links', () => {
		const out = renderMemberNoteLog(base);
		expect(out).toContain('<@U0TARGET>');
		expect(out).toContain('<@U0ADMIN>');
	});

	it('treats an empty DM body as no DM', () => {
		expect(renderMemberNoteLog({ ...base, kind: 'warning', dmBody: '' })).not.toContain(
			'sent to them',
		);
	});
});
