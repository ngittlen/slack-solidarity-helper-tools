// Builds the create/update body for the Mobilize v1 events API.
//
// The v1 body is much narrower than the private dashboard one this replaced.
// Fields with no API equivalent are simply not set, and synced events get
// Mobilize's defaults for them: VAN activist-code sync, check-in, post-signup
// asks, day-before confirmation, and contact-host. See mobilize-migrator/README.md.

/**
 * The timezone Mobilize displays every synced event in.
 *
 * Michigan is `America/Detroit`, but Mobilize validates this field against a
 * fixed choice list that rejects it ("not a valid choice"), so we send
 * `America/New_York` — same offsets, same DST rules.
 */
export const CAMPAIGN_TIMEZONE = 'America/New_York';

/**
 * Event types, as the v1 string enum. The campaign only uses these two; the
 * full list is in the API docs.
 */
export const EVENT_TYPE = {
	COMMUNITY: 'COMMUNITY',
	COMMUNITY_CANVASS: 'COMMUNITY_CANVASS',
} as const;

export type EventTypeName = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

export interface Timeslot {
	/** Present only when updating an existing shift. */
	id?: number;
	/** Unix seconds. */
	startDate: number;
	endDate: number;
	maxAttendees: number | null;
}

/**
 * Required by the API on both create and update. Resolved from the settings
 * page with an env-var fallback — Solidarity events carry no contact data.
 */
export interface EventContact {
	name: string;
	emailAddress: string;
	phoneNumber: string;
}

export interface EventInput {
	title: string;
	description: string;
	/** Must be a Mobilize-hosted URL from POST /v1/images. See lib/image.ts. */
	imageUrl?: string;
	eventType: EventTypeName;
	timezone: string;
	locationName: string;
	addressLine1: string;
	city: string;
	state: string;
	zipcode: string;
	country: string;
	/**
	 * The Solidarity event's hide-address-until-RSVP flag. v1 has no field for
	 * location privacy — the "This event's address is private" string in the docs
	 * is what Mobilize RETURNS for a redacted event, not an input — so the street
	 * line is simply omitted. City, region and postal code still go, which gives a
	 * usable map pin without publishing the venue's address.
	 */
	locationIsPrivate: boolean;
	contact: EventContact;
	timeslots: Timeslot[];
}

function buildContact(contact: EventContact): Record<string, string> {
	const out: Record<string, string> = {};
	if (contact.name) out.name = contact.name;
	if (contact.emailAddress) out.email_address = contact.emailAddress;
	if (contact.phoneNumber) out.phone_number = contact.phoneNumber;
	return out;
}

export function buildEventPayload(input: EventInput): Record<string, unknown> {
	return {
		title: input.title,
		description: input.description,
		timezone: input.timezone,
		event_type: input.eventType,
		visibility: 'PUBLIC',
		contact: buildContact(input.contact),
		location: {
			venue: input.locationName,
			// Always exactly two lines, per the API docs.
			address_lines: [input.locationIsPrivate ? '' : input.addressLine1, ''],
			locality: input.city,
			region: input.state,
			postal_code: input.zipcode,
			country: input.country,
		},
		...(input.imageUrl ? { featured_image_url: input.imageUrl } : {}),
		timeslots: input.timeslots.map((slot) => ({
			...(slot.id ? { id: slot.id } : {}),
			start_date: slot.startDate,
			end_date: slot.endDate,
			...(slot.maxAttendees !== null ? { max_attendees: slot.maxAttendees } : {}),
		})),
	};
}
