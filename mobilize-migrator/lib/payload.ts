// Builds the create-event body for Mobilize's private dashboard API.
//
// The field set and defaults are lifted verbatim from a real create request
// captured off the dashboard (private/event-create-request.json) — the endpoint is
// undocumented and rejects partial bodies, so we send the whole shape and only
// vary the fields that describe the event.

/**
 * Numeric event_type codes. Undocumented, and unreadable from the API (GET and
 * OPTIONS both 405, and the JS bundle is Cloudflare-blocked), so these were
 * confirmed empirically: create a throwaway event far in the future with a
 * candidate code, read the string name back off the public API, delete it.
 *
 * Neighbours found the same way, in case another is ever needed:
 * 18 OFFICE_OPENING, 19 BARNSTORM, 20 SOLIDARITY_EVENT, 22 SIGNATURE_GATHERING,
 * 23 CARPOOL.
 */
export const EVENT_TYPE = {
	COMMUNITY: 5,
	COMMUNITY_CANVASS: 21,
} as const;

export const VISIBILITY_PUBLIC = 1;

export interface Timeslot {
	/** Local wall time, no offset: "2026-08-31T09:00" */
	startsAtNaive: string;
	endsAtNaive: string;
	maxAttendees: number | null;
}

export interface EventInput {
	name: string;
	description: string;
	/**
	 * Must already live in Mobilize's uploads bucket — foreign URLs are rejected
	 * with `400 Invalid URL.` See lib/image.ts.
	 */
	imageUrl?: string;
	eventType: number;
	timezone: string;
	locationName: string;
	addressLine1: string;
	city: string;
	state: string;
	zipcode: string;
	country: string;
	lat: number | null;
	lon: number | null;
	locationIsPrivate: boolean;
	timeslots: Timeslot[];
}

/**
 * The campaign's VAN activist-code sync, copied from the captured request so
 * migrated events tag signups the same way dashboard-created ones do.
 */
export const VAN_ACTIVIST_CODE_ID = 5451761;

export function buildEventPayload(input: EventInput): Record<string, unknown> {
	return {
		name: input.name,
		van_name: '',
		description: input.description,
		image_url: input.imageUrl ?? '',
		pro_tips: '',
		location_name: input.locationName,
		address_line1: input.addressLine1,
		address_line2: '',
		city: input.city,
		state: input.state,
		zipcode: input.zipcode,
		contact_name: '',
		contact_number: '',
		accessibility_notes: '',
		private_details: null,
		virtual_join_url: null,
		advocacy_campaign_id: null,
		check_in_enabled: true,
		country: input.country,
		custom_event_type_name: null,
		day_before_confirmation_message: null,
		fundraiser_config_id: null,
		group_signup_size_limit: null,
		lat: input.lat,
		lon: input.lon,
		owning_org_van_location_id: null,
		participant_goal: null,
		rendered_private_details: null,
		shift_closed_message: null,
		shift_followup_message: null,
		tags: null,
		virtual_action_button_text: null,
		virtual_action_url: null,
		zoom_meeting_id: null,
		accessibility_features: [],
		custom_signup_fields: [],
		event_suggestions: [],
		disable_participant_count: false,
		disable_participant_goal: false,
		group_signup_enabled: false,
		select_all_timeslots_enabled: false,
		self_check_in_enabled: false,
		is_statewide: false,
		location_is_private: input.locationIsPrivate,
		accessibility_status: 3,
		chat_enabled: false,
		contact_host_enabled: true,
		day_before_confirmation_is_enabled: true,
		event_type: input.eventType,
		group_should_include_all_events_by_hosts_by_default: false,
		is_virtual: false,
		post_signup_asks: [1, 3, 4, 2],
		primary_locale: 'en',
		registration_mode: 1,
		reply_to_email: '',
		shift_followup_email_enabled: true,
		timezone: input.timezone,
		virtual_action_disable_advance_signups: false,
		visibility: VISIBILITY_PUBLIC,
		volunteer_check_in_is_enabled: false,
		zoom_meeting_type: null,
		is_virtual_flexible: false,
		group_suggested_events: [],
		owning_groups: [],
		co_host_ids: [],
		timeslots: input.timeslots.map((slot) => ({
			starts_at_naive: slot.startsAtNaive,
			ends_at_naive: slot.endsAtNaive,
			max_attendees: slot.maxAttendees,
			private_details: null,
			virtual_join_url: null,
			zoom_meeting_id: null,
			zoom_meeting_type: null,
			waitlist_enabled: false,
			waitlist_auto_advance_enabled: false,
			close_registration_before_start_threshold: null,
			close_registration_before_start_unit: null,
		})),
		van_event_config: {
			van_event_type_id: null,
			van_role_id: null,
			van_host_role_id: null,
			van_registered_status_id: null,
			van_cancelled_status_id: null,
			van_confirmed_status_id: null,
			van_waitlisted_status_id: null,
			van_source_code: null,
			van_source_code_id: null,
		},
		van_event_activist_code_config: {
			sync_as_activist_code: true,
			van_activist_code_id: VAN_ACTIVIST_CODE_ID,
		},
	};
}
