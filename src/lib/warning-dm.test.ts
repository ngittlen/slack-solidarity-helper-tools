import { describe, it, expect } from 'vitest';
import { renderWarningDm, validateWarningTemplate, DEFAULT_WARNING_DM } from './warning-dm.js';

const NO_CHANNELS = new Map<string, string>();
const CHANNELS = new Map([['rules', 'C0RULES']]);

const ctx = (over: Partial<Parameters<typeof renderWarningDm>[1]> = {}) => ({
	warningNumber: 1,
	noteBody: 'Posted off-topic links after being asked to stop.',
	messageLink: null,
	...over,
});

describe('renderWarningDm', () => {
	it('falls back to the built-in default when the template is blank', () => {
		const out = renderWarningDm('   ', ctx(), NO_CHANNELS);
		expect(out).toContain('This is your first warning');
	});

	it('substitutes {{nth}} via ordinal', () => {
		expect(renderWarningDm('Warning {{nth}}.', ctx({ warningNumber: 3 }), NO_CHANNELS)).toBe(
			'Warning third.',
		);
		expect(renderWarningDm('Warning {{nth}}.', ctx({ warningNumber: 12 }), NO_CHANNELS)).toBe(
			'Warning 12th.',
		);
	});

	it('blockquotes the note body', () => {
		const out = renderWarningDm('{{note}}', ctx({ noteBody: 'line one\nline two' }), NO_CHANNELS);
		expect(out).toBe('> line one\n> line two');
	});

	it('expands {{message_link}} to the whole clause, not a bare URL', () => {
		const out = renderWarningDm(
			'{{message_link}}',
			ctx({ messageLink: 'https://w.slack.com/archives/C1/p1712345678123456' }),
			NO_CHANNELS,
		);
		expect(out).toBe('This is regarding: https://w.slack.com/archives/C1/p1712345678123456');
	});

	// The reason the lead-in lives inside the expansion: a warning with no
	// linked message must not read "This is regarding:" followed by nothing.
	it('leaves no dangling clause when there is no link', () => {
		const out = renderWarningDm('Before.\n{{message_link}}\nAfter.', ctx(), NO_CHANNELS);
		expect(out).not.toContain('regarding');
		expect(out).toBe('Before.\n\nAfter.');
	});

	it('appends the link when the template omits the token', () => {
		const out = renderWarningDm(
			'Your {{nth}} warning.',
			ctx({ messageLink: 'https://w.slack.com/archives/C1/p1712345678123456' }),
			NO_CHANNELS,
		);
		expect(out).toBe(
			'Your first warning.\n\nThis is regarding: https://w.slack.com/archives/C1/p1712345678123456',
		);
	});

	it('does not append twice when the token is present', () => {
		const out = renderWarningDm(
			'{{message_link}}',
			ctx({ messageLink: 'https://w.slack.com/archives/C1/p1712345678123456' }),
			NO_CHANNELS,
		);
		expect(out.match(/regarding/g)).toHaveLength(1);
	});

	it('drops an empty note cleanly', () => {
		expect(renderWarningDm('A\n{{note}}\nB', ctx({ noteBody: '   ' }), NO_CHANNELS)).toBe('A\n\nB');
	});

	it('collapses the gaps left by empty expansions', () => {
		const out = renderWarningDm(
			'Start.\n\n{{note}}\n\n{{message_link}}\n\nEnd.',
			ctx({ noteBody: '', messageLink: null }),
			NO_CHANNELS,
		);
		expect(out).toBe('Start.\n\nEnd.');
	});

	it('resolves #channel links, including inside a substituted note', () => {
		expect(renderWarningDm('See #rules for details', ctx(), CHANNELS)).toBe(
			'See <#C0RULES> for details',
		);
		expect(renderWarningDm('{{note}}', ctx({ noteBody: 'read #rules' }), CHANNELS)).toBe(
			'> read <#C0RULES>',
		);
	});

	it('leaves unknown channel names as literal text', () => {
		expect(renderWarningDm('See #nowhere for details', ctx(), CHANNELS)).toBe(
			'See #nowhere for details',
		);
	});

	it('renders the default template end to end', () => {
		const out = renderWarningDm(
			'',
			ctx({ warningNumber: 2, messageLink: 'https://w.slack.com/archives/C1/p1712345678123456' }),
			NO_CHANNELS,
		);
		expect(out).toContain('This is your second warning');
		expect(out).toContain('> Posted off-topic links');
		expect(out).toContain('This is regarding: https://w.slack.com/');
		expect(out).not.toContain('{{');
	});
});

describe('validateWarningTemplate', () => {
	it('accepts an empty template (means "use the default")', () => {
		expect(validateWarningTemplate('')).toEqual({ ok: true, channelNames: [] });
	});

	it('accepts the built-in default', () => {
		expect(validateWarningTemplate(DEFAULT_WARNING_DM).ok).toBe(true);
	});

	it('returns referenced channel names for the endpoint to verify', () => {
		const result = validateWarningTemplate('{{nth}} warning. See #rules and #general for details');
		expect(result).toEqual({ ok: true, channelNames: ['rules', 'general'] });
	});

	it('requires {{nth}}', () => {
		const result = validateWarningTemplate('You have been warned.');
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('{{nth}}');
	});

	it.each([
		['{{Nth}} warning', '{{nth}}'],
		['{{nth}} warning {{link}}', '{{link}}'],
		['{{nth}} warning {{ordinal}}', '{{ordinal}}'],
	])('rejects unknown or miscased tokens in %s', (template) => {
		expect(validateWarningTemplate(template).ok).toBe(false);
	});

	it('tolerates whitespace inside a known token when reporting unknowns', () => {
		// `{{nth }}` is not substituted by the literal replace, so it must not
		// pass validation as if it were the real token.
		expect(validateWarningTemplate('{{nth }} warning').ok).toBe(false);
	});
});
