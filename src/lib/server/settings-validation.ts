// Save-time validators called by the settings save endpoints (NAV-5..NAV-9)
// before persisting a picked id. Each validator membership-checks the id
// against the autocomplete-sources cache — never issues its own upstream
// lookup, per the 2026-05-21 clarification — and reports an explicit
// success-or-failure outcome. None of them ever throws (FR-017).
//
// The `transient` flag on a failure result is the machine-readable signal
// NAV-5+ uses to choose between "try again" (cached list unavailable) and
// "not a valid choice" (id is genuinely absent); UI MUST branch on this
// boolean rather than string-matching `error` (FR-019, SC-006).

import type { WebClient } from '@slack/web-api';
import {
	getSlackChannels,
	getSlackUsers,
	getSolidarityChapters,
} from './autocomplete-sources.js';

export interface ValidationFailure {
	ok: false;
	error: string;
	transient: boolean;
}

export type ChannelValidationResult =
	| { ok: true; name: string }
	| ValidationFailure;

export type UserValidationResult =
	| { ok: true; displayName: string }
	| ValidationFailure;

export type ChapterValidationResult =
	| { ok: true; name: string }
	| ValidationFailure;

const TRANSIENT_CHANNEL =
	'Slack channel list is temporarily unavailable. Try again in a moment.';
const TRANSIENT_USER =
	'Slack user list is temporarily unavailable. Try again in a moment.';
const TRANSIENT_CHAPTER =
	'Solidarity chapter list is temporarily unavailable. Try again in a moment.';

const INVALID_CHANNEL = 'Not a valid Slack channel choice.';
const INVALID_USER = 'Not a valid Slack user choice.';
const INVALID_CHAPTER = 'Not a valid Solidarity chapter choice.';

export async function validateSlackChannel(
	slack: WebClient,
	channelId: string,
): Promise<ChannelValidationResult> {
	try {
		const { items } = await getSlackChannels(slack);
		const hit = items.find((c) => c.id === channelId);
		if (hit) return { ok: true, name: hit.name };
		return { ok: false, error: INVALID_CHANNEL, transient: false };
	} catch {
		// Source threw (cold cache + fetch failed). Fail closed, mark transient
		// so the UI offers "try again" rather than telling the admin their
		// pick was wrong (FR-018, FR-019).
		return { ok: false, error: TRANSIENT_CHANNEL, transient: true };
	}
}

export async function validateSlackUser(
	slack: WebClient,
	userId: string,
): Promise<UserValidationResult> {
	try {
		const { items } = await getSlackUsers(slack);
		const hit = items.find((u) => u.id === userId);
		if (hit) return { ok: true, displayName: hit.name };
		return { ok: false, error: INVALID_USER, transient: false };
	} catch {
		return { ok: false, error: TRANSIENT_USER, transient: true };
	}
}

export async function validateSolidarityChapter(
	token: string,
	chapterId: number,
): Promise<ChapterValidationResult> {
	try {
		const { items } = await getSolidarityChapters(token);
		const hit = items.find((c) => c.id === chapterId);
		if (hit) return { ok: true, name: hit.name };
		return { ok: false, error: INVALID_CHAPTER, transient: false };
	} catch {
		return { ok: false, error: TRANSIENT_CHAPTER, transient: true };
	}
}