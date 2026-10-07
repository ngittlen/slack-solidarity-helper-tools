// Keyed digests of a VanID and of a door, so the uncontacted-door count can be
// computed without the database ever holding either.
//
// Keyed, not a plain hash, and that is the whole point: a VanID is a small
// integer, so SHA-256 of one is reversed by hashing every integer up to a few
// hundred million — minutes on a laptop. An HMAC under VAN_ID_HASH_SECRET is
// useless to anyone holding the database without the server's environment.
//
// Truncated to 128 bits. van_turf_roster is the largest table in the database
// (a few hundred people × a few thousand turfs), and collisions at that size are
// out of reach for any realistic population.
//
// No $env import, so scripts/ can use it under tsx; the secret is injected.
// Rotating the secret orphans every stored digest: clear van_turf_roster and
// van_person_contacts, null van_turfs.roster_saved_list_id, and let the next
// sync rebuild both.

import { createHmac } from 'node:crypto';

const DIGEST_BYTES = 16;

export interface PersonHasher {
	/** Digest of a VanID. Whitespace is trimmed so the export and ContactHistory
	 *  agree however either pads the column. */
	person(vanId: string): Buffer;
	/** Digest of a door: the one-line `Address` plus ZIP, normalised. */
	door(address: string, zip: string): Buffer;
}

/**
 * Normalise an address to a door key.
 *
 * VAN's type-5 `Address` is the whole line — `"4190 S Kirkman Rd Apt 912 ,
 * Orlando, FL 32811"` — with the unit included, so apartments count as separate
 * doors, as they do in VAN's own doorCount. There is no household or address id
 * column to use instead. Case, runs of whitespace and the stray space before
 * each comma are the variations seen between rows of one list.
 */
export function doorKey(address: string, zip: string): string {
	const line = address
		.toLowerCase()
		.replace(/\s*,\s*/g, ',')
		.replace(/\s+/g, ' ')
		.trim();
	return `${line}|${zip.trim().slice(0, 5)}`;
}

export function createPersonHasher(secret: string): PersonHasher {
	if (!secret) throw new Error('VAN_ID_HASH_SECRET is empty');
	const digest = (label: string, value: string): Buffer =>
		createHmac('sha256', secret).update(`${label}:${value}`).digest().subarray(0, DIGEST_BYTES);
	return {
		person: (vanId) => digest('van-person-v1', vanId.trim()),
		door: (address, zip) => digest('van-door-v1', doorKey(address, zip)),
	};
}
