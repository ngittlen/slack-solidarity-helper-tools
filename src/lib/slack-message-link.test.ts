import { describe, it, expect } from 'vitest';
import { parseSlackMessageLink, buildSlackPermalink } from './slack-message-link.js';

describe('parseSlackMessageLink', () => {
	it('parses a top-level message permalink', () => {
		const ref = parseSlackMessageLink(
			'https://myworkspace.slack.com/archives/C0ABC123/p1712345678123456',
		);
		expect(ref).toEqual({
			url: 'https://myworkspace.slack.com/archives/C0ABC123/p1712345678123456',
			channelId: 'C0ABC123',
			ts: '1712345678.123456',
			threadTs: null,
		});
	});

	it('parses a threaded reply permalink and keeps thread_ts', () => {
		const ref = parseSlackMessageLink(
			'https://myworkspace.slack.com/archives/C0ABC123/p1712345999000100?thread_ts=1712345678.123456&cid=C0ABC123',
		);
		expect(ref?.channelId).toBe('C0ABC123');
		expect(ref?.ts).toBe('1712345999.000100');
		expect(ref?.threadTs).toBe('1712345678.123456');
	});

	it('reinserts the decimal point before the last six digits', () => {
		expect(parseSlackMessageLink('https://w.slack.com/archives/C1/p1234567890000001')?.ts).toBe(
			'1234567890.000001',
		);
	});

	it('trims surrounding whitespace', () => {
		expect(
			parseSlackMessageLink('  https://w.slack.com/archives/C1/p1712345678123456  ')?.channelId,
		).toBe('C1');
	});

	it('accepts workspace subdomains with hyphens', () => {
		expect(
			parseSlackMessageLink('https://my-org-slack.slack.com/archives/C1/p1712345678123456'),
		).not.toBeNull();
	});

	it.each([
		['empty string', ''],
		['whitespace only', '   '],
		['not a URL', 'nonsense'],
		['non-Slack host', 'https://evil.example.com/archives/C0ABC123/p1712345678123456'],
		['Slack host but not a message link', 'https://myworkspace.slack.com/team/U0ABC123'],
		['missing the p-prefixed timestamp', 'https://myworkspace.slack.com/archives/C0ABC123'],
		['lookalike host', 'https://slack.com.evil.test/archives/C1/p1712345678123456'],
	])('rejects %s', (_label, input) => {
		expect(parseSlackMessageLink(input)).toBeNull();
	});
});

describe('buildSlackPermalink', () => {
	it('builds a top-level permalink', () => {
		expect(
			buildSlackPermalink({
				teamDomain: 'myworkspace',
				channelId: 'C0ABC123',
				ts: '1712345678.123456',
			}),
		).toBe('https://myworkspace.slack.com/archives/C0ABC123/p1712345678123456');
	});

	it('adds thread_ts and cid for a threaded reply', () => {
		expect(
			buildSlackPermalink({
				teamDomain: 'myworkspace',
				channelId: 'C0ABC123',
				ts: '1712345999.000100',
				threadTs: '1712345678.123456',
			}),
		).toBe(
			'https://myworkspace.slack.com/archives/C0ABC123/p1712345999000100?thread_ts=1712345678.123456&cid=C0ABC123',
		);
	});

	it('omits the thread suffix when threadTs equals ts (a thread parent)', () => {
		expect(
			buildSlackPermalink({
				teamDomain: 'w',
				channelId: 'C1',
				ts: '1712345678.123456',
				threadTs: '1712345678.123456',
			}),
		).toBe('https://w.slack.com/archives/C1/p1712345678123456');
	});

	it.each([
		['team domain', { teamDomain: null, channelId: 'C1', ts: '1.2' }],
		['channel', { teamDomain: 'w', channelId: undefined, ts: '1.2' }],
		['timestamp', { teamDomain: 'w', channelId: 'C1', ts: '' }],
	])('returns null when %s is missing', (_label, parts) => {
		expect(buildSlackPermalink(parts)).toBeNull();
	});

	it('round-trips with parseSlackMessageLink', () => {
		const url = buildSlackPermalink({
			teamDomain: 'myworkspace',
			channelId: 'C0ABC123',
			ts: '1712345678.123456',
		})!;
		const ref = parseSlackMessageLink(url)!;
		expect(ref.channelId).toBe('C0ABC123');
		expect(ref.ts).toBe('1712345678.123456');
	});
});
