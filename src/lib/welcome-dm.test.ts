import { describe, it, expect } from 'vitest';
import { DEFAULT_WELCOME_DM, renderWelcomeDm } from './welcome-dm.js';

const NAME_TO_ID = new Map([
	['general', 'C_GEN'],
	['announcements', 'C_ANN'],
]);

describe('renderWelcomeDm', () => {
	it('falls back to the default template when blank', () => {
		const out = renderWelcomeDm('   ', ['C1'], NAME_TO_ID);
		expect(out).toBe(DEFAULT_WELCOME_DM.replace('{{channels}}', '<#C1>'));
	});

	it('substitutes {{channels}} with comma-joined mentions', () => {
		const out = renderWelcomeDm('Added to {{channels}}. Enjoy!', ['C1', 'C2'], NAME_TO_ID);
		expect(out).toBe('Added to <#C1>, <#C2>. Enjoy!');
	});

	it('renders {{channels}} as empty string when there are no channels', () => {
		expect(renderWelcomeDm('Added to {{channels}}.', [], NAME_TO_ID)).toBe('Added to .');
	});

	it('resolves #channel-name tokens to <#id> links', () => {
		const out = renderWelcomeDm('Join {{channels}} and check #general', ['C1'], NAME_TO_ID);
		expect(out).toBe('Join <#C1> and check <#C_GEN>');
	});

	it('leaves an unknown #name as literal text', () => {
		expect(renderWelcomeDm('See #nope', [], NAME_TO_ID)).toBe('See #nope');
	});

	it('does not double-process an existing <#C…> mention', () => {
		expect(renderWelcomeDm('Hi <#C0ABC123>', [], NAME_TO_ID)).toBe('Hi <#C0ABC123>');
	});

	it('substitutes every occurrence of {{channels}}', () => {
		expect(renderWelcomeDm('{{channels}} / {{channels}}', ['C1'], NAME_TO_ID)).toBe(
			'<#C1> / <#C1>',
		);
	});
});
