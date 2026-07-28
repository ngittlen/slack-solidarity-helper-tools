import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { saveAppConfig, type AppConfigPatch, type Editor } from '$lib/server/settings.js';
import { validateSlackChannel } from '$lib/server/settings-validation.js';
import { getSlackChannels } from '$lib/server/autocomplete-sources.js';
import { extractChannelNames } from '$lib/welcome-dm.js';
import { MAX_TICKER_COLUMNS_PER_SECOND, MIN_TICKER_COLUMNS_PER_SECOND } from '$lib/ticker-speed.js';

// App-config writes for the settings page. The body is a patch: only the keys
// present are validated and written (saveAppConfig's set-only contract keeps
// the other columns untouched). No seed step — app_config falls back to env
// per-field via NULL columns, so a partial row never shadows the other fields.
//
// Channel ids are membership-checked against the cached live channel list
// (503 on a transient list outage, 400 for an unknown id). The ranking alpha
// must be a finite number in [0, 1] — the range the /settings slider offers
// and the span of meaningful power-law exponents for the score.
// The countdown fields use '' as the explicit "not configured" value (the
// saveAppConfig set-only contract reserves NULL for "keep"), so clearing the
// countdown posts empty strings. The end datetime must be ISO-parseable and is
// re-serialized to canonical ISO so every reader gets a uniform format.
interface AppConfigBody {
	slackTrackingChannelId?: unknown;
	slackGrowthReportChannelId?: unknown;
	slackMobilizeSyncChannelId?: unknown;
	mobilizeContactName?: unknown;
	mobilizeContactEmail?: unknown;
	mobilizeContactPhone?: unknown;
	slackGrowthReportRankingAlpha?: unknown;
	countdownLabel?: unknown;
	countdownEndAt?: unknown;
	welcomeDmMessage?: unknown;
	doorTickerColumnsPerSecond?: unknown;
}

const COUNTDOWN_LABEL_MAX_LENGTH = 80;
const CONTACT_FIELD_MAX_LENGTH = 200;
// Deliberately permissive: this is an organizer typing their own campaign
// address, and a rejected-but-valid address is worse than one Mobilize itself
// will reject on the next sync with a clear error.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Slack renders a section block's text up to 3000 chars; keep the stored
// template within that so a saved message can never be rejected at send time.
const WELCOME_DM_MAX_LENGTH = 3000;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: AppConfigBody;
	try {
		body = (await request.json()) as AppConfigBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const patch: AppConfigPatch = {};

	for (const key of [
		'slackTrackingChannelId',
		'slackGrowthReportChannelId',
		'slackMobilizeSyncChannelId',
	] as const) {
		const value = body[key];
		if (value === undefined) continue;
		if (typeof value !== 'string' || value.trim() === '') {
			return json({ error: `${key} must be a non-empty string` }, { status: 400 });
		}
		const result = await validateSlackChannel(slack, value);
		if (!result.ok) {
			return json({ error: result.error }, { status: result.transient ? 503 : 400 });
		}
		patch[key] = value;
	}

	// Contact fields use '' as the explicit "not configured" value, same as the
	// countdown, so clearing one falls back to its MOBILIZE_CONTACT_* env var.
	for (const key of [
		'mobilizeContactName',
		'mobilizeContactEmail',
		'mobilizeContactPhone',
	] as const) {
		const value = body[key];
		if (value === undefined) continue;
		if (typeof value !== 'string' || value.trim().length > CONTACT_FIELD_MAX_LENGTH) {
			return json(
				{ error: `${key} must be a string of at most ${CONTACT_FIELD_MAX_LENGTH} characters` },
				{ status: 400 },
			);
		}
		const trimmed = value.trim();
		if (key === 'mobilizeContactEmail' && trimmed !== '' && !EMAIL_PATTERN.test(trimmed)) {
			return json({ error: 'mobilizeContactEmail must be an email address' }, { status: 400 });
		}
		patch[key] = trimmed;
	}

	if (body.slackGrowthReportRankingAlpha !== undefined) {
		const alpha = body.slackGrowthReportRankingAlpha;
		if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
			return json(
				{ error: 'slackGrowthReportRankingAlpha must be a number between 0 and 1' },
				{ status: 400 },
			);
		}
		patch.slackGrowthReportRankingAlpha = alpha;
	}

	// Ticker speed is bounded rather than free: below the minimum the board is
	// unreadable, and above the maximum a step lasts under a frame and the
	// stepped animation turns to stutter.
	if (body.doorTickerColumnsPerSecond !== undefined) {
		const rate = body.doorTickerColumnsPerSecond;
		if (
			typeof rate !== 'number' ||
			!Number.isFinite(rate) ||
			rate < MIN_TICKER_COLUMNS_PER_SECOND ||
			rate > MAX_TICKER_COLUMNS_PER_SECOND
		) {
			return json(
				{
					error: `doorTickerColumnsPerSecond must be a number between ${MIN_TICKER_COLUMNS_PER_SECOND} and ${MAX_TICKER_COLUMNS_PER_SECOND}`,
				},
				{ status: 400 },
			);
		}
		patch.doorTickerColumnsPerSecond = rate;
	}

	if (body.countdownLabel !== undefined) {
		const label = body.countdownLabel;
		if (typeof label !== 'string' || label.trim().length > COUNTDOWN_LABEL_MAX_LENGTH) {
			return json(
				{
					error: `countdownLabel must be a string of at most ${COUNTDOWN_LABEL_MAX_LENGTH} characters`,
				},
				{ status: 400 },
			);
		}
		patch.countdownLabel = label.trim();
	}

	if (body.countdownEndAt !== undefined) {
		const endAt = body.countdownEndAt;
		if (typeof endAt !== 'string') {
			return json({ error: 'countdownEndAt must be a string' }, { status: 400 });
		}
		if (endAt === '') {
			patch.countdownEndAt = '';
		} else {
			const parsed = new Date(endAt);
			if (Number.isNaN(parsed.getTime())) {
				return json(
					{ error: 'countdownEndAt must be an ISO datetime or empty to clear' },
					{ status: 400 },
				);
			}
			patch.countdownEndAt = parsed.toISOString();
		}
	}

	if (body.welcomeDmMessage !== undefined) {
		const message = body.welcomeDmMessage;
		if (typeof message !== 'string' || message.length > WELCOME_DM_MAX_LENGTH) {
			return json(
				{
					error: `welcomeDmMessage must be a string of at most ${WELCOME_DM_MAX_LENGTH} characters`,
				},
				{ status: 400 },
			);
		}
		// Reject a typo'd `#channel-name` now so the admin fixes it here rather
		// than shipping a dead link into every new member's DM. An empty message
		// clears back to the built-in default and references nothing.
		const names = extractChannelNames(message);
		if (names.length > 0) {
			let items;
			try {
				({ items } = await getSlackChannels(slack));
			} catch {
				return json(
					{ error: 'Slack channel list is temporarily unavailable. Try again in a moment.' },
					{ status: 503 },
				);
			}
			const known = new Set(items.map((c) => c.name.toLowerCase()));
			const unknown = names.filter((n) => !known.has(n));
			if (unknown.length > 0) {
				return json(
					{ error: `Unknown channel(s): ${unknown.map((n) => `#${n}`).join(', ')}` },
					{ status: 400 },
				);
			}
		}
		// Store trimmed; '' means "use the built-in default" at send time.
		patch.welcomeDmMessage = message.trim();
	}

	if (Object.keys(patch).length === 0) {
		return json({ error: 'no recognized app-config fields in body' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	await saveAppConfig(db, patch, editor);
	return json({ ok: true });
};
