// What /turfs is given for the canvass events on its map: Solidarity events
// carrying the admin's canvass tag, one card per place they meet.

/** One time a canvass meets, as a row on its place's card. */
export interface CanvassSession {
	/** `${eventId}-${sessionId}`. */
	id: string;
	/** "Today", "Tomorrow", "Sun, Oct 19". */
	dayLabel: string;
	/** "10:00 AM – 1:00 PM". */
	timeLabel: string;
	/** UTC ISO. */
	startsAt: string;
	endsAt: string;
	/** The event's own title when it isn't the card's: a place can host
	 *  more than one event. Null when the card's title already says it. */
	title: string | null;
	/** Its event's Solidarity page, where volunteers RSVP. An event without
	 *  one isn't shown. */
	rsvpUrl: string;
}

/** Every upcoming tagged session at one place, as a card above the turf list
 *  and a single marker on the map: sessions at the same spot would otherwise
 *  be drawn exactly on top of one another. */
export interface CanvassEventCard {
	/** The soonest session's id. */
	id: string;
	/** The soonest session's title, or its event's. */
	title: string;
	place: string;
	/** Plain text from the soonest session's event; '' when it has none. */
	description: string;
	point: { lat: number; lng: number };
	/** Soonest first; never empty. */
	sessions: CanvassSession[];
}
