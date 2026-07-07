import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { saveAppConfig, type AppConfigPatch, type Editor } from '$lib/server/settings.js';
import { validateSlackChannel } from '$lib/server/settings-validation.js';

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
	slackGrowthReportRankingAlpha?: unknown;
	countdownLabel?: unknown;
	countdownEndAt?: unknown;
}

const COUNTDOWN_LABEL_MAX_LENGTH = 80;

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

	for (const key of ['slackTrackingChannelId', 'slackGrowthReportChannelId'] as const) {
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

	if (body.countdownLabel !== undefined) {
		const label = body.countdownLabel;
		if (typeof label !== 'string' || label.trim().length > COUNTDOWN_LABEL_MAX_LENGTH) {
			return json(
				{ error: `countdownLabel must be a string of at most ${COUNTDOWN_LABEL_MAX_LENGTH} characters` },
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
