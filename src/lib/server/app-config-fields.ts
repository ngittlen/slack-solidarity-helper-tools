// Per-field validation for the app_config patch endpoint.
//
// Extracted from the route because the endpoint grew one `if (body.x !== …)`
// block per field, and the two DM-template fields had drifted into near-
// identical copies of the same `#channel` check. Here each field is one entry
// in a table, the shared shapes are written once, and adding a config field is
// a one-line change rather than another branch in a growing handler.
//
// The route itself keeps only what is genuinely its job: the auth gate, the
// body parse, the loop, and the save.
//
// Validators return the same discriminated shape as settings-validation.ts,
// with the HTTP status carried on the failure — a transient upstream outage is
// a 503 the admin can retry, a bad value is a 400 they must fix.

import type { WebClient } from '@slack/web-api';
import type { AppConfigPatch } from './settings.js';
import { validateSlackChannel } from './settings-validation.js';
import { getSlackChannels } from './autocomplete-sources.js';
import { extractChannelNames } from '../welcome-dm.js';
import { validateWarningTemplate } from '../warning-dm.js';
import { MAX_TICKER_COLUMNS_PER_SECOND, MIN_TICKER_COLUMNS_PER_SECOND } from '../ticker-speed.js';

export interface FieldContext {
	slack: WebClient;
}

export type FieldResult<T> =
	{ ok: true; value: T } | { ok: false; error: string; status: 400 | 503 };

export type FieldValidator<T> = (
	value: unknown,
	ctx: FieldContext,
) => FieldResult<T> | Promise<FieldResult<T>>;

const fail = (error: string, status: 400 | 503 = 400): FieldResult<never> => ({
	ok: false,
	error,
	status,
});

const TRANSIENT_CHANNELS = 'Slack channel list is temporarily unavailable. Try again in a moment.';

// ---------------------------------------------------------------------------
// Field-shape builders
// ---------------------------------------------------------------------------

/** A Slack channel id, membership-checked against the cached live list. */
function slackChannelField(label: string): FieldValidator<string> {
	return async (value, ctx) => {
		if (typeof value !== 'string' || value.trim() === '') {
			return fail(`${label} must be a non-empty string`);
		}
		const result = await validateSlackChannel(ctx.slack, value);
		if (!result.ok) return fail(result.error, result.transient ? 503 : 400);
		return { ok: true, value };
	};
}

/**
 * Free text with a length cap, stored trimmed. `''` is allowed and meaningful:
 * saveAppConfig reserves NULL for "leave as-is", so an empty string is how the
 * UI says "clear this and fall back to the env var / built-in default".
 */
function boundedTextField(label: string, maxLength: number): FieldValidator<string> {
	return (value) => {
		if (typeof value !== 'string' || value.trim().length > maxLength) {
			return fail(`${label} must be a string of at most ${maxLength} characters`);
		}
		return { ok: true, value: value.trim() };
	};
}

// Deliberately permissive: this is an organizer typing their own campaign
// address, and a rejected-but-valid address is worse than one Mobilize itself
// will reject on the next sync with a clear error.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailField(label: string, maxLength: number): FieldValidator<string> {
	const text = boundedTextField(label, maxLength);
	return (value, ctx) => {
		const result = text(value, ctx) as FieldResult<string>;
		if (!result.ok) return result;
		// '' clears the field; only a non-empty value has to look like an address.
		if (result.value !== '' && !EMAIL_PATTERN.test(result.value)) {
			return fail(`${label} must be an email address`);
		}
		return result;
	};
}

function numberInRangeField(label: string, min: number, max: number): FieldValidator<number> {
	return (value) => {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
			return fail(`${label} must be a number between ${min} and ${max}`);
		}
		return { ok: true, value };
	};
}

/** ISO datetime, re-serialized to canonical form so every reader gets the same
 *  format. `''` clears the countdown. */
function isoDateTimeField(label: string): FieldValidator<string> {
	return (value) => {
		if (typeof value !== 'string') return fail(`${label} must be a string`);
		if (value === '') return { ok: true, value: '' };
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) {
			return fail(`${label} must be an ISO datetime or empty to clear`);
		}
		return { ok: true, value: parsed.toISOString() };
	};
}

/** Result of a template-specific pre-check, before the shared channel check. */
type TemplateCheck = { ok: true; channelNames: string[] } | { ok: false; error: string };

/**
 * A DM template: length-capped, optionally run through a template-specific
 * check, then verified so every `#channel-name` it mentions actually exists.
 *
 * That last step is the shared part and the reason this builder exists — a
 * typo'd channel name is invisible until the DM has already gone out to a
 * member, at which point it can't be taken back. Both the welcome and warning
 * templates need exactly the same guard.
 */
function dmTemplateField(
	label: string,
	maxLength: number,
	check: (message: string) => TemplateCheck,
): FieldValidator<string> {
	return async (value, ctx) => {
		if (typeof value !== 'string' || value.length > maxLength) {
			return fail(`${label} must be a string of at most ${maxLength} characters`);
		}

		const checked = check(value);
		if (!checked.ok) return fail(checked.error);

		if (checked.channelNames.length > 0) {
			let items;
			try {
				({ items } = await getSlackChannels(ctx.slack));
			} catch {
				return fail(TRANSIENT_CHANNELS, 503);
			}
			const known = new Set(items.map((c) => c.name.toLowerCase()));
			const unknown = checked.channelNames.filter((n) => !known.has(n));
			if (unknown.length > 0) {
				return fail(`Unknown channel(s): ${unknown.map((n) => `#${n}`).join(', ')}`);
			}
		}

		// Store trimmed; '' means "use the built-in default" at send time.
		return { ok: true, value: value.trim() };
	};
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const COUNTDOWN_LABEL_MAX_LENGTH = 80;
const CONTACT_FIELD_MAX_LENGTH = 200;
// Slack renders a section block's text up to 3000 chars; keep the stored
// template within that so a saved message can never be rejected at send time.
const DM_TEMPLATE_MAX_LENGTH = 3000;

// AppConfigPatch is a Partial, so Required<> recovers the full field set with
// each value's real type — which is what the table is keyed against.
type AppConfigFields = Required<AppConfigPatch>;

/**
 * Every writable app-config field and how to validate it. Exhaustive over
 * `AppConfigPatch` — a new key on the patch type is a compile error here until
 * it is given a validator, which is the point: an unvalidated field can't
 * reach `saveAppConfig` by omission.
 */
export const APP_CONFIG_FIELDS: {
	[K in keyof AppConfigFields]: FieldValidator<AppConfigFields[K]>;
} = {
	slackTrackingChannelId: slackChannelField('slackTrackingChannelId'),
	slackGrowthReportChannelId: slackChannelField('slackGrowthReportChannelId'),
	slackMobilizeSyncChannelId: slackChannelField('slackMobilizeSyncChannelId'),
	slackMemberNoteChannelId: slackChannelField('slackMemberNoteChannelId'),

	// Contact fields use '' as the explicit "not configured" value, so clearing
	// one falls back to its MOBILIZE_CONTACT_* env var.
	mobilizeContactName: boundedTextField('mobilizeContactName', CONTACT_FIELD_MAX_LENGTH),
	mobilizeContactEmail: emailField('mobilizeContactEmail', CONTACT_FIELD_MAX_LENGTH),
	mobilizeContactPhone: boundedTextField('mobilizeContactPhone', CONTACT_FIELD_MAX_LENGTH),

	// [0, 1] is the range the /settings slider offers and the span of meaningful
	// power-law exponents for the growth score.
	slackGrowthReportRankingAlpha: numberInRangeField('slackGrowthReportRankingAlpha', 0, 1),

	// Bounded rather than free: below the minimum the board is unreadable, and
	// above the maximum a step lasts under a frame and the stepped animation
	// turns to stutter.
	doorTickerColumnsPerSecond: numberInRangeField(
		'doorTickerColumnsPerSecond',
		MIN_TICKER_COLUMNS_PER_SECOND,
		MAX_TICKER_COLUMNS_PER_SECOND,
	),

	countdownLabel: boundedTextField('countdownLabel', COUNTDOWN_LABEL_MAX_LENGTH),
	countdownEndAt: isoDateTimeField('countdownEndAt'),

	welcomeDmMessage: dmTemplateField(
		'welcomeDmMessage',
		DM_TEMPLATE_MAX_LENGTH,
		// An empty message clears back to the built-in default and references
		// nothing, so there is no token check here — only the channel names.
		(message) => ({ ok: true, channelNames: extractChannelNames(message) }),
	),

	warningDmMessage: dmTemplateField(
		'warningDmMessage',
		DM_TEMPLATE_MAX_LENGTH,
		// Additionally rejects unknown/miscased `{{tokens}}` and a missing
		// `{{nth}}` — a dropped token isn't visible until a warning has already
		// been sent to a member.
		validateWarningTemplate,
	),
};

export type AppConfigFieldKey = keyof AppConfigFields;

export const APP_CONFIG_FIELD_KEYS = Object.keys(APP_CONFIG_FIELDS) as AppConfigFieldKey[];
