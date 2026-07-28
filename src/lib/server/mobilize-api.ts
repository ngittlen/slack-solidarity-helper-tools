// Shared credentials for both Mobilize syncs (events out, attendees back).
//
// The organization holds a Mobilize API key with write access granted, so both
// directions go through the documented v1 API. Unlike the borrowed browser
// session this replaced, the key does not expire on its own — a 403 means it
// was revoked, mistyped, or lost its restricted-endpoint grant, not that
// somebody needs to log in and copy a cookie.
//
// This module exists so mobilize-migrator/lib/* never imports $env: it is the
// one place $env values become the MobilizeApiConfig those modules consume.

import type { MobilizeApiConfig } from '../../../mobilize-migrator/lib/mobilize.js';
import { MOBILIZE_API_KEY, MOBILIZE_ORG_ID } from './env.js';

export function loadMobilizeApi(purpose: string): MobilizeApiConfig {
	if (!MOBILIZE_API_KEY) {
		throw new Error(`MOBILIZE_API_KEY is not set — ${purpose} cannot authenticate`);
	}
	// No default org: syncing into the wrong organization publishes events under
	// someone else's name, so an unset value has to stop the run.
	if (!Number.isFinite(MOBILIZE_ORG_ID) || MOBILIZE_ORG_ID <= 0) {
		throw new Error(`MOBILIZE_ORG_ID is not a positive integer — ${purpose} cannot run`);
	}
	return { apiKey: MOBILIZE_API_KEY, orgId: MOBILIZE_ORG_ID };
}
