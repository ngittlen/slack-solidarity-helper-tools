import { describe, expect, it } from 'vitest';
import { icsFile, icsText, icsTime } from './ics.js';

describe('icsTime', () => {
	it('writes the UTC form without separators or milliseconds', () => {
		expect(icsTime(new Date('2026-10-18T14:00:00.123Z'))).toBe('20261018T140000Z');
	});
});

describe('icsText', () => {
	it('escapes backslashes, commas, semicolons and newlines', () => {
		expect(icsText('a\\b, c; d\r\ne')).toBe('a\\\\b\\, c\\; d\\ne');
	});
});

describe('icsFile', () => {
	it('builds one event with CRLF line endings', () => {
		const file = icsFile(
			{
				uid: 'canvass-1-2@app.example',
				start: new Date('2026-10-27T16:00:00Z'),
				end: new Date('2026-10-27T19:00:00Z'),
				summary: 'Door knock',
				location: 'Union Hall, Flint',
				description: 'Bring water.',
			},
			new Date('2026-10-26T12:00:00Z'),
		);
		expect(file.split('\r\n')).toEqual([
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//mentor-walks//EN',
			'BEGIN:VEVENT',
			'UID:canvass-1-2@app.example',
			'DTSTAMP:20261026T120000Z',
			'DTSTART:20261027T160000Z',
			'DTEND:20261027T190000Z',
			'SUMMARY:Door knock',
			'LOCATION:Union Hall\\, Flint',
			'DESCRIPTION:Bring water.',
			'END:VEVENT',
			'END:VCALENDAR',
		]);
	});
});
