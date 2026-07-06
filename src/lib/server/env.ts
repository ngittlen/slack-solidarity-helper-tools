// Environment variable exports and startup validation.
// Uses $env/dynamic/private so Vite's .env/.env.local loading works in dev.
// Call validateEnv() from hooks.server.ts init() — never at module level.

import { env } from '$env/dynamic/private';

const get = (key: string) => (env as Record<string, string | undefined>)[key] ?? '';

export const SLACK_BOT_TOKEN = get('SLACK_BOT_TOKEN');
export const SLACK_CLIENT_ID = get('SLACK_CLIENT_ID');
export const SLACK_CLIENT_SECRET = get('SLACK_CLIENT_SECRET');
export const SLACK_SIGNING_SECRET = get('SLACK_SIGNING_SECRET');
export const SLACK_ALLOWED_USER_IDS = new Set(
	get('SLACK_ALLOWED_USER_IDS').split(',').map((id) => id.trim()).filter(Boolean),
);
// Slack user id that is ALWAYS granted admin, regardless of the DB-backed
// allowed_slack_users list (or its SLACK_ALLOWED_USER_IDS fallback) — even
// when that list is empty or unreadable. Escape hatch so a mis-edited allowed
// list can never lock every admin out of /pending and /settings.
export const SLACK_SUPERUSER_ID = get('SLACK_SUPERUSER_ID');
export const SLACK_TRACKING_CHANNEL_ID = get('SLACK_TRACKING_CHANNEL_ID');
export const SLACK_GROWTH_REPORT_CHANNEL_ID = get('SLACK_GROWTH_REPORT_CHANNEL_ID');
// Comma-separated list of Solidarity chapter IDs to omit from reports — both
// the weekly growth leaderboard and the dashboard charts (e.g. test chapters,
// internal-only chapters).
export const REPORT_EXCLUDED_CHAPTER_IDS = new Set(
	get('REPORT_EXCLUDED_CHAPTER_IDS')
		.split(',')
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n)),
);
// Power-law exponent for the weekly growth ranking score:
//   score = newJoins / (existing + 1) ^ alpha
// Smaller value favors larger chapters; larger value (toward 1) is closer to
// pure rate. See weekly-growth-report.ts for the full rationale. Returns
// undefined if unset/unparseable so the function falls back to its default.
export const SLACK_GROWTH_REPORT_RANKING_ALPHA: number | undefined = (() => {
	const raw = get('SLACK_GROWTH_REPORT_RANKING_ALPHA');
	if (!raw) return undefined;
	const parsed = parseFloat(raw);
	if (!Number.isFinite(parsed)) {
		console.warn(
			`[env] SLACK_GROWTH_REPORT_RANKING_ALPHA is not a valid number: "${raw}" — using default`,
		);
		return undefined;
	}
	return parsed;
})();
export const TURSO_DATABASE_URL = get('TURSO_DATABASE_URL');
export const TURSO_AUTH_TOKEN = get('TURSO_AUTH_TOKEN');
export const WEBHOOK_SECRET = get('WEBHOOK_SECRET');
export const APP_URL = get('APP_URL');
export const PORT = parseInt(get('PORT') || '3000', 10);
export const REDIRECT_URI = `${APP_URL}/auth/slack/callback`;

export const SOLIDARITY_API_TOKEN = get('SOLIDARITY_API_TOKEN');

// Shared secret for internal cron-triggered endpoints (e.g. nightly snapshot).
// Callers pass it as ?key=<value>.
export const INTERNAL_CRON_SECRET = get('INTERNAL_CRON_SECRET');

export interface ChapterEntry {
	chapterId: number;
	channelId: string;
	name: string;
}

// JSON array mapping solidarity chapter IDs to Slack channel IDs and display names.
// Fallback for the /settings chapter↔channel editor: used while the
// chapter_channel_map table is empty, and copied into it before its first
// interactive edit.
// Example: [{"chapterId":123,"channelId":"C012AB3CD","name":"Washtenaw County"}]
export const SOLIDARITY_CHAPTER_CHANNEL_MAP: ChapterEntry[] = (() => {
	try {
		return JSON.parse(get('SOLIDARITY_CHAPTER_CHANNEL_MAP') || '[]') as ChapterEntry[];
	} catch {
		console.error('[env] SOLIDARITY_CHAPTER_CHANNEL_MAP is not valid JSON — defaulting to []');
		return [];
	}
})();

const REQUIRED_VARS = [
	'SLACK_BOT_TOKEN',
	'SLACK_CLIENT_ID',
	'SLACK_CLIENT_SECRET',
	'SLACK_SIGNING_SECRET',
	'SLACK_ALLOWED_USER_IDS',
	'SLACK_TRACKING_CHANNEL_ID',
	'TURSO_DATABASE_URL',
	'WEBHOOK_SECRET',
	'APP_URL',
] as const;

export function validateEnv(): void {
	for (const key of REQUIRED_VARS) {
		if (!(env as Record<string, string | undefined>)[key]) {
			console.error(`Missing required environment variable: ${key}`);
			process.exit(1);
		}
	}
	if (!TURSO_DATABASE_URL.startsWith('file:') && !TURSO_AUTH_TOKEN) {
		console.error('Missing required environment variable: TURSO_AUTH_TOKEN');
		process.exit(1);
	}
	if (!SOLIDARITY_API_TOKEN) {
		console.warn('[env] SOLIDARITY_API_TOKEN is not set — the team_join welcome flow will be disabled (every lookup returns null).');
	}
}