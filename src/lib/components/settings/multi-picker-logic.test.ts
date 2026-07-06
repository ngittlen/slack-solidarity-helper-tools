import { describe, it, expect } from 'vitest';
import { sharedChannelIds, diffSelection } from './multi-picker-logic.js';

describe('sharedChannelIds', () => {
	const entries = [
		{ chapterId: 1, channelId: 'C_A' },
		{ chapterId: 1, channelId: 'C_B' },
		{ chapterId: 2, channelId: 'C_B' },
		{ chapterId: 2, channelId: 'C_C' },
		{ chapterId: 3, channelId: 'C_B' },
	];

	it('returns [] for an empty selection', () => {
		expect(sharedChannelIds([], entries)).toEqual([]);
	});

	it('returns all of a single selected chapter’s channels in entry order', () => {
		expect(sharedChannelIds([1], entries)).toEqual(['C_A', 'C_B']);
	});

	it('returns only channels every selected chapter has', () => {
		expect(sharedChannelIds([1, 2], entries)).toEqual(['C_B']);
		expect(sharedChannelIds([1, 2, 3], entries)).toEqual(['C_B']);
	});

	it('returns [] when any selected chapter has no entries', () => {
		expect(sharedChannelIds([1, 99], entries)).toEqual([]);
		expect(sharedChannelIds([99], entries)).toEqual([]);
	});

	it('returns [] when selected chapters share nothing', () => {
		const disjoint = [
			{ chapterId: 1, channelId: 'C_A' },
			{ chapterId: 2, channelId: 'C_C' },
		];
		expect(sharedChannelIds([1, 2], disjoint)).toEqual([]);
	});
});

describe('diffSelection', () => {
	it('reports an added id', () => {
		expect(diffSelection(['a'], ['a', 'b'])).toEqual({ added: ['b'], removed: [] });
	});

	it('reports a removed id', () => {
		expect(diffSelection(['a', 'b'], ['a'])).toEqual({ added: [], removed: ['b'] });
	});

	it('reports nothing for identical selections regardless of order', () => {
		expect(diffSelection(['a', 'b'], ['b', 'a'])).toEqual({ added: [], removed: [] });
	});
});
