import { describe, expect, it } from 'vitest';

import { parseAddress } from './address.js';

describe('parseAddress', () => {
	it('parses street, city, state, country', () => {
		expect(parseAddress('4400 South Saginaw Street, Flint, MI, USA')).toMatchObject({
			addressLine1: '4400 South Saginaw Street',
			city: 'Flint',
			state: 'MI',
			zipcode: '',
			country: 'US',
			quality: 'full',
		});
	});

	it('parses a combined state+zip segment', () => {
		expect(parseAddress('1 South Saginaw Street, Pontiac, MI 48342, USA')).toMatchObject({
			addressLine1: '1 South Saginaw Street',
			city: 'Pontiac',
			state: 'MI',
			zipcode: '48342',
			quality: 'full',
		});
	});

	it('parses state and zip given as separate trailing segments', () => {
		expect(parseAddress('111 Division Avenue South, Grand Rapids, MI, 49503')).toMatchObject({
			addressLine1: '111 Division Avenue South',
			city: 'Grand Rapids',
			state: 'MI',
			zipcode: '49503',
			quality: 'full',
		});
	});

	it('keeps a leading venue name out of the street line', () => {
		expect(
			parseAddress('Herrick District Library - Main Library, South River Avenue, Holland, MI, USA'),
		).toMatchObject({
			addressLine1: 'South River Avenue',
			venueExtra: 'Herrick District Library - Main Library',
			city: 'Holland',
			state: 'MI',
			quality: 'full',
		});
	});

	it('handles a city with a period in it', () => {
		expect(
			parseAddress("Bird's Eye Outfitters, East Portage Avenue, Sault Ste. Marie, MI, USA"),
		).toMatchObject({
			addressLine1: 'East Portage Avenue',
			city: 'Sault Ste. Marie',
			state: 'MI',
			quality: 'full',
		});
	});

	it('marks a city-only address rather than inventing a street', () => {
		expect(parseAddress('Ann Arbor, MI, USA')).toMatchObject({
			addressLine1: '',
			city: 'Ann Arbor',
			state: 'MI',
			quality: 'city-only',
		});
	});

	it('rejects a state-only address', () => {
		expect(parseAddress('Michigan, USA').quality).toBe('unusable');
	});

	it('rejects placeholders and virtual links', () => {
		expect(parseAddress('TBD ').quality).toBe('unusable');
		expect(parseAddress('https://meet.google.com/kpp-cqto-nag').quality).toBe('unusable');
		expect(parseAddress('').quality).toBe('unusable');
		expect(parseAddress(null).quality).toBe('unusable');
	});

	it('parses an address with no comma before the city as best it can', () => {
		// "857 e chicago rd coldwater, mi 49036" — street and city run together.
		const parsed = parseAddress('857 E Chicago Rd Coldwater, MI 49036');
		expect(parsed.state).toBe('MI');
		expect(parsed.zipcode).toBe('49036');
		expect(parsed.quality).toBe('city-only');
	});

	it('defaults country to US when omitted', () => {
		expect(parseAddress('2721 W Michigan Ave, Kalamazoo, MI 49006').country).toBe('US');
	});
});
