/**
 * List everyone currently in a Slack channel with the date they joined the
 * Slack workspace (not the channel — on the free plan the channel's join
 * messages age out of history, so that date isn't recoverable).
 *
 * The date comes from the app's `slack_joins` table, written when the bot
 * welcomes a new member (and backfilled for earlier members). Anyone without a
 * row falls back to the join date on their Slack profile, if Slack has one.
 *
 * Usage (from project root):
 *
 *   npx tsx --env-file=.env.local scripts/channel-member-join-dates.ts <channelId>
 *   npx tsx --env-file=.env.local scripts/channel-member-join-dates.ts <channelId> --csv > joins.csv
 *
 * Bots and deactivated accounts are left out. The bot must be able to see the
 * channel — for a private channel that means it has to be a member.
 *
 * Required env vars: SLACK_BOT_TOKEN, TURSO_DATABASE_URL,
 * TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { WebClient } from '@slack/web-api';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { errMessage } from '../src/lib/err-message.js';
import { slackJoins } from '../src/lib/server/schema.js';

const argv = process.argv.slice(2);
const CSV = argv.includes('--csv');
const [CHANNEL] = argv.filter((a) => !a.startsWith('--'));
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';

const slack = new WebClient(SLACK_BOT_TOKEN);
const db = drizzle(createClient(dbConfig));

// ---------------------------------------------------------------------------
// Slack helpers
// ---------------------------------------------------------------------------

async function channelMemberIds(channel: string): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await slack.conversations.members({ channel, limit: 1000, cursor });
		ids.push(...(page.members ?? []));
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return ids;
}

/** Active, non-bot workspace users' display names by id. */
async function humanNames(): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const page = await slack.users.list({ limit: 200, cursor });
		for (const u of page.members ?? []) {
			if (!u.id || u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
			names.set(u.id, u.profile?.real_name || u.profile?.display_name || u.name || u.id);
		}
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return names;
}

/** The workspace join date Slack reports for a user, if any — same fields
 *  scripts/backfill-slack-joins.ts reads. */
async function slackProfileJoinedAt(user: string): Promise<string | null> {
	const info = await slack.users.info({ user });
	const u = info.user as { date_joined?: number; created?: number } | undefined;
	const ts = u?.date_joined ?? u?.created;
	return typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
}

async function channelName(channel: string): Promise<string> {
	const info = await slack.conversations.info({ channel });
	return info.channel?.name ? `#${info.channel.name}` : channel;
}

function csvField(value: string): string {
	return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Row {
	id: string;
	name: string;
	/** ISO timestamp, or null when neither source has one. */
	joinedAt: string | null;
	source: 'app' | 'slack profile' | '';
}

async function main(): Promise<void> {
	if (!SLACK_BOT_TOKEN) {
		console.error('SLACK_BOT_TOKEN is not set — run with npx tsx --env-file=.env.local …');
		process.exit(1);
	}
	if (!CHANNEL) {
		console.error(
			'Usage: channel-member-join-dates.ts <channelId> [--csv]  (see the header comment)',
		);
		process.exit(1);
	}

	const [label, memberIds, names] = await Promise.all([
		channelName(CHANNEL),
		channelMemberIds(CHANNEL),
		humanNames(),
	]);
	const humanIds = memberIds.filter((id) => names.has(id));

	const recorded = new Map<string, string | null>();
	if (humanIds.length > 0) {
		const found = await db
			.select({ id: slackJoins.slackUserId, joinedAt: slackJoins.joinedAt })
			.from(slackJoins)
			.where(inArray(slackJoins.slackUserId, humanIds));
		for (const r of found) recorded.set(r.id, r.joinedAt);
	}

	const rows: Row[] = [];
	for (const id of humanIds) {
		const name = names.get(id)!;
		const appJoinedAt = recorded.get(id);
		if (appJoinedAt) {
			rows.push({ id, name, joinedAt: appJoinedAt, source: 'app' });
			continue;
		}
		const profileJoinedAt = await slackProfileJoinedAt(id);
		rows.push({
			id,
			name,
			joinedAt: profileJoinedAt,
			source: profileJoinedAt ? 'slack profile' : '',
		});
	}
	// Oldest first; unknown dates last.
	rows.sort(
		(a, b) => (a.joinedAt ?? '￿').localeCompare(b.joinedAt ?? '￿') || a.name.localeCompare(b.name),
	);

	if (CSV) {
		console.log('user_id,name,joined_slack,source');
		for (const r of rows) {
			console.log([r.id, r.name, r.joinedAt?.slice(0, 10) ?? '', r.source].map(csvField).join(','));
		}
		return;
	}

	console.log(`${label} (${CHANNEL}) — ${rows.length} members (bots and deactivated left out)\n`);
	const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
	for (const r of rows) {
		const date = r.joinedAt?.slice(0, 10) ?? 'unknown';
		const note = r.source === 'slack profile' ? '(from Slack profile)' : '';
		console.log(`  ${date.padEnd(10)}  ${r.name.padEnd(nameWidth)}  ${r.id}  ${note}`.trimEnd());
	}
	const unknown = rows.filter((r) => !r.joinedAt).length;
	if (unknown > 0) console.log(`\n${unknown} member(s) have no recorded join date.`);
}

main().catch((err) => {
	console.error(errMessage(err));
	process.exit(1);
});
