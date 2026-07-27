// Most Solidarity sessions don't populate the structured location_data
// components — only ~a quarter carry address_line_1/address_city. The rest have
// a Google-formatted `location_address` string plus coordinates. This parses
// that string back into the parts Mobilize wants.
//
// Real formats present in the campaign's data:
//   "4400 South Saginaw Street, Flint, MI, USA"
//   "1 South Saginaw Street, Pontiac, MI 48342, USA"
//   "111 Division Avenue South, Grand Rapids, MI, 49503"
//   "Herrick District Library - Main Library, South River Avenue, Holland, MI, USA"
//   "Ann Arbor, MI, USA"          → city only, no street
//   "Michigan, USA"               → unusable
//   "TBD "                        → unusable
//   "https://meet.google.com/..." → actually virtual

export interface ParsedAddress {
	addressLine1: string;
	city: string;
	state: string;
	zipcode: string;
	country: string;
	/** Venue-ish leading segments, e.g. "Herrick District Library - Main Library". */
	venueExtra: string;
	/** 'full' has a street; 'city-only' has no street line; 'unusable' can't be mapped. */
	quality: 'full' | 'city-only' | 'unusable';
}

const UNUSABLE = (): ParsedAddress => ({
	addressLine1: '',
	city: '',
	state: '',
	zipcode: '',
	country: 'US',
	venueExtra: '',
	quality: 'unusable',
});

const COUNTRY_PARTS = new Set(['usa', 'us', 'united states', 'united states of america']);
const STATE_NAMES: Record<string, string> = { michigan: 'MI', ohio: 'OH', indiana: 'IN' };

/** "MI 48342" | "MI" | "48342" → whichever of state/zip are present. */
function parseStateZip(part: string): { state: string; zipcode: string } | null {
	const trimmed = part.trim();
	const both = /^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(trimmed);
	if (both) return { state: both[1].toUpperCase(), zipcode: both[2] };
	if (/^[A-Za-z]{2}$/.test(trimmed)) return { state: trimmed.toUpperCase(), zipcode: '' };
	if (/^\d{5}(?:-\d{4})?$/.test(trimmed)) return { state: '', zipcode: trimmed.slice(0, 5) };
	const named = STATE_NAMES[trimmed.toLowerCase()];
	if (named) return { state: named, zipcode: '' };
	return null;
}

export function parseAddress(locationAddress: string | null | undefined): ParsedAddress {
	const raw = (locationAddress ?? '').trim();
	if (!raw || /^tbd\b/i.test(raw) || /^https?:\/\//i.test(raw)) return UNUSABLE();

	let parts = raw
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0) return UNUSABLE();

	const country = 'US';
	if (COUNTRY_PARTS.has(parts[parts.length - 1].toLowerCase())) {
		parts = parts.slice(0, -1);
	}

	// The tail may hold state and zip as one part ("MI 48342") or two ("MI", "49503").
	let state = '';
	let zipcode = '';
	for (let i = 0; i < 2 && parts.length > 0; i++) {
		const parsed = parseStateZip(parts[parts.length - 1]);
		if (!parsed) break;
		// Don't consume the only remaining part as a state — that leaves no city.
		if (parts.length === 1) break;
		state ||= parsed.state;
		zipcode ||= parsed.zipcode;
		parts = parts.slice(0, -1);
	}

	if (parts.length === 0) return UNUSABLE();

	const city = parts[parts.length - 1];
	const rest = parts.slice(0, -1);

	// A lone "Michigan" or "Ann Arbor" with no street: usable only as city-level.
	if (rest.length === 0) {
		if (!state) return UNUSABLE();
		return {
			addressLine1: '',
			city,
			state,
			zipcode,
			country,
			venueExtra: '',
			quality: 'city-only',
		};
	}

	return {
		addressLine1: rest[rest.length - 1],
		city,
		state,
		zipcode,
		country,
		venueExtra: rest.slice(0, -1).join(', '),
		quality: 'full',
	};
}
