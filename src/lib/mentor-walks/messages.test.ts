import { describe, expect, it } from 'vitest';
import {
	alertMessage,
	changedMessage,
	esc,
	howDidItGoMessage,
	joinedMessage,
	leftMessage,
	mentorCheckinMessage,
	noShowPost,
	noShowReply,
	offMessage,
	reminderMessage,
	whenLabel,
	type WalkFacts,
} from './messages.js';
import { noticeLines } from '../van/notice-text.js';

// 2026-10-18 12:00 in Detroit. The walk is at 5:30 PM that day.
const NOW = new Date('2026-10-18T16:00:00.000Z');
const APP = 'https://turf.example.org';
const WALK: WalkFacts = {
	publicId: 'k3Xq9vR2mT8w',
	chapterId: 71,
	mentorName: 'Kimberly B.',
	startsAt: '2026-10-18T21:30:00.000Z',
	place: 'Ypsilanti District Library, 229 W Michigan Ave',
	note: 'By the front doors, under the awning.',
	lookFor: 'Campaign merch',
	phone: '(734) 555-0142',
	seats: 3,
};

describe('mentor walk messages', () => {
	it('says when as the prototype did', () => {
		expect(whenLabel(WALK.startsAt, NOW)).toBe('Today at 5:30 PM');
		expect(whenLabel(WALK.startsAt, NOW, true)).toBe('today at 5:30 PM');
		expect(whenLabel('2026-10-19T14:00:00.000Z', NOW)).toBe('Tomorrow at 10:00 AM');
		expect(whenLabel('2026-10-21T17:00:00.000Z', NOW)).toBe('Wed, Oct 21 at 1:00 PM');
	});

	it('tells the mentor who joined and who left, and the seats left', () => {
		expect(joinedMessage(WALK, 'Sam R.', 2, NOW)).toBe(
			'*Sam R.* joined your walk *Today at 5:30 PM* at Ypsilanti District Library.\n2 of 3 seats left.',
		);
		expect(leftMessage(WALK, 'Sam R.', 3, NOW)).toBe(
			'*Sam R.* can no longer make your walk *Today at 5:30 PM*.\n3 of 3 seats left.',
		);
	});

	it('links changes and cancellations back to the walk on /turfs', () => {
		expect(changedMessage(WALK, APP, NOW)).toContain(
			`give up your seat on <${APP}/turfs?chapter=71#walk-k3Xq9vR2mT8w|/turfs>.`,
		);
		expect(offMessage(WALK, APP, NOW)).toBe(
			'The walk with *Kimberly B.* on *Today at 5:30 PM* has been cancelled.\n' +
				`Other walks near you are on <${APP}/turfs?chapter=71|/turfs>.`,
		);
	});

	it('reminds with the place, the note, how to spot the mentor and the number', () => {
		expect(reminderMessage(WALK, NOW)).toBe(
			[
				"Reminder: you're walking with *Kimberly B.* *today at 5:30 PM*.",
				'Meet at Ypsilanti District Library, 229 W Michigan Ave. By the front doors, under the awning.',
				'Look for: Campaign merch.',
				'Running late? Text Kimberly at (734) 555-0142.',
			].join('\n'),
		);
		// A mentor without merch says what to look for instead.
		expect(reminderMessage({ ...WALK, lookFor: 'Red *Tigers* cap' }, NOW)).toContain(
			'Look for: Red Tigers cap.',
		);
		expect(reminderMessage({ ...WALK, phone: null, note: null }, NOW)).toContain(
			"The mentor didn't leave a number. Meet at the place above.",
		);
	});

	it('asks after the walk', () => {
		const next = new Date('2026-10-19T14:00:00.000Z');
		expect(mentorCheckinMessage(WALK, APP, next)).toMatch(
			/^Thanks for taking new people out yesterday! Who showed up\?/,
		);
		expect(howDidItGoMessage(WALK, APP)).toContain(
			"*I went* · *Mentor didn't show* · *I couldn't make it*",
		);
	});

	it('alerts with the distance, the seats, anything held back, and a way to stop', () => {
		const text = alertMessage(WALK, 1, '1.2 mi', 2, APP, NOW);
		expect(text).toContain('at Ypsilanti District Library (1.2 mi).');
		expect(text).toContain('1 seat open.');
		expect(text).toContain('And 2 more walks near you.');
		expect(text).toContain(`<${APP}/turfs?mentorAlerts=stop|Stop these alerts>`);
		expect(alertMessage(WALK, 3, '1.2 mi', 0, APP, NOW)).not.toContain('more');
	});

	it('posts no-shows for organizers', () => {
		expect(noShowPost(WALK, 'Washtenaw County', 'Priya K.', APP)).toBe(
			[
				':warning: *Mentor walk no-show reported* by Priya K.',
				'Mentor: *Kimberly B.* · Washtenaw County',
				'Walk: Sun, Oct 18 at 5:30 PM · Ypsilanti District Library, 229 W Michigan Ave',
				`Organizers can review it on <${APP}/turfs/organizer/mentor-walks|/turfs/organizer>.`,
			].join('\n'),
		);
		expect(noShowReply('Dev M.')).toBe('Also reported by Dev M.');
		expect(noShowReply('Dev')).toBe('Also reported by Dev.');
	});

	it('keeps what people typed from becoming links, mentions or styling', () => {
		expect(esc('<!channel> *big* & _small_')).toBe('&lt;!channel&gt; big &amp; small');
		const sneaky = { ...WALK, place: '<https://evil.example|Click> St.', mentorName: 'Kim *B*' };
		const text = reminderMessage(sneaky, NOW);
		expect(text).toContain('Meet at &lt;https://evil.example|Click&gt; St. By the front doors');
		// And on /turfs, where Google and Apple volunteers read the same words,
		// no link to another site comes out of it.
		const links = noticeLines(text, APP)
			.flat()
			.filter((s) => s.href);
		expect(links).toEqual([]);
	});
});
