import { describe, it, expect } from 'vitest';
import { extractChannelNames, resolveChannelLinks } from './channel-tokens.js';

const NAME_TO_ID = new Map([
	['general', 'C_GEN'],
	['announcements', 'C_ANN'],
]);

describe('extractChannelNames', () => {
	it('pulls lowercased, deduped channel names from #tokens', () => {
		expect(extractChannelNames('Say hi in #General and #announcements and #general again')).toEqual(
			['general', 'announcements'],
		);
	});

	it('ignores the # inside an existing <#C…> mention', () => {
		expect(extractChannelNames('Welcome to <#C0ABC123> — see also #general')).toEqual(['general']);
	});

	it('returns nothing when there are no tokens', () => {
		expect(extractChannelNames('no channels here')).toEqual([]);
	});

	it('accepts dashes, underscores, and dots in a name', () => {
		expect(extractChannelNames('#door-knocking #phone_bank #team.leads')).toEqual([
			'door-knocking',
			'phone_bank',
			'team.leads',
		]);
	});

	it('does not treat a bare # as a token', () => {
		expect(extractChannelNames('costs # dollars')).toEqual([]);
	});

	it('does not start a name with a dash', () => {
		// The pattern requires an alphanumeric first character, so "#-foo" is not
		// a channel reference at all.
		expect(extractChannelNames('#-foo')).toEqual([]);
	});
});

describe('resolveChannelLinks', () => {
	it('replaces a known name with a link', () => {
		expect(resolveChannelLinks('Say hi in #general', NAME_TO_ID)).toBe('Say hi in <#C_GEN>');
	});

	it('replaces every occurrence, not just the first', () => {
		expect(resolveChannelLinks('#general then #announcements then #general', NAME_TO_ID)).toBe(
			'<#C_GEN> then <#C_ANN> then <#C_GEN>',
		);
	});

	it('is case-insensitive on the name', () => {
		expect(resolveChannelLinks('#General', NAME_TO_ID)).toBe('<#C_GEN>');
	});

	it('leaves an unknown name literal rather than stripping it', () => {
		// A renamed or archived channel should degrade the message, not blow a
		// hole in the middle of a sentence.
		expect(resolveChannelLinks('Try #no-such-channel', NAME_TO_ID)).toBe('Try #no-such-channel');
	});

	it('leaves an already-resolved <#C…> mention alone', () => {
		// Guards against double-processing when a caller substitutes channel
		// mentions before resolving (renderWelcomeDm does exactly this).
		expect(resolveChannelLinks('Welcome to <#C0ABC123>', NAME_TO_ID)).toBe(
			'Welcome to <#C0ABC123>',
		);
	});

	it('passes text with no tokens through untouched', () => {
		expect(resolveChannelLinks('nothing to do here', NAME_TO_ID)).toBe('nothing to do here');
	});

	it('leaves everything literal when the map is empty', () => {
		// channelNameToId returns an empty map when Slack is unreachable; the
		// message still has to go out.
		expect(resolveChannelLinks('Say hi in #general', new Map())).toBe('Say hi in #general');
	});
});
