// A one-event calendar file, for the "Add to calendar" buttons on /turfs.

export interface CalendarEvent {
	/** Globally unique: `mentor-walk-abc@host`. */
	uid: string;
	start: Date;
	end: Date;
	summary: string;
	location: string;
	description: string;
}

/** iCalendar's UTC form: 20261018T140000Z. */
export function icsTime(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
}

/** Escapes for an iCalendar text value. */
export function icsText(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\r?\n/g, '\\n');
}

export function icsFile(event: CalendarEvent, now = new Date()): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//mentor-walks//EN',
		'BEGIN:VEVENT',
		`UID:${event.uid}`,
		`DTSTAMP:${icsTime(now)}`,
		`DTSTART:${icsTime(event.start)}`,
		`DTEND:${icsTime(event.end)}`,
		`SUMMARY:${icsText(event.summary)}`,
		`LOCATION:${icsText(event.location)}`,
		`DESCRIPTION:${icsText(event.description)}`,
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n');
}

/** Hands the browser `event` as `filename` to save or open. */
export function downloadIcs(event: CalendarEvent, filename: string): void {
	const url = URL.createObjectURL(new Blob([icsFile(event)], { type: 'text/calendar' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	// Released a minute on: Safari reads the URL after click() returns, and a
	// URL revoked first downloads nothing.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
