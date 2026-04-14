/**
 * One-time backfill script: sync all existing Slack members against Solidarity.
 *
 * For each active, non-bot Slack user with an email address it will:
 *   1. Look up their Solidarity profile
 *   2. Invite them to any chapter channel(s) they aren't already in
 *   3. Set their City and State custom profile fields
 *
 * Usage (from the project root):
 *   npx tsx --env-file=.env.local scripts/backfill-members.ts
 *   npx tsx --env-file=.env.local scripts/backfill-members.ts --dry-run
 *
 * Required env vars (same as the app):
 *   SLACK_BOT_TOKEN, SLACK_USER_TOKEN, SOLIDARITY_API_TOKEN,
 *   SOLIDARITY_CHAPTER_CHANNEL_MAP, SLACK_CITY_FIELD_ID, SLACK_STATE_FIELD_ID
 */

import { WebClient } from '@slack/web-api';

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const SOLIDARITY_API_TOKEN = process.env.SOLIDARITY_API_TOKEN ?? '';

const SOLIDARITY_CHAPTER_CHANNEL_MAP: Record<string, string> = (() => {
	try {
		return JSON.parse(process.env.SOLIDARITY_CHAPTER_CHANNEL_MAP ?? '{}') as Record<string, string>;
	} catch {
		console.error('SOLIDARITY_CHAPTER_CHANNEL_MAP is not valid JSON');
		process.exit(1);
	}
})();

for (const [key, val] of Object.entries({ SLACK_BOT_TOKEN, SOLIDARITY_API_TOKEN })) {
	if (!val) {
		console.error(`Missing required env var: ${key}`);
		process.exit(1);
	}
}

const bot = new WebClient(SLACK_BOT_TOKEN);

// ---------------------------------------------------------------------------
// Solidarity API
// ---------------------------------------------------------------------------

interface SolidarityUser {
	chapter_id: number | null;
	chapter_ids: number[];
}

async function getSolidarityUser(email: string): Promise<SolidarityUser | null> {
	const url = `https://api.solidarity.tech/v1/users?email=${encodeURIComponent(email)}&_limit=1`;
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${SOLIDARITY_API_TOKEN}` },
	});
	if (res.status === 429) {
		// Respect rate limit: wait and retry once
		const retryAfter = parseInt(res.headers.get('Retry-After') ?? '30', 10);
		console.warn(`  [solidarity] rate limited — waiting ${retryAfter}s`);
		await sleep(retryAfter * 1000);
		return getSolidarityUser(email);
	}
	if (!res.ok) return null;
	const data = (await res.json()) as { data?: SolidarityUser[] };
	return data.data?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function chapterIdsFor(u: SolidarityUser): number[] {
	if (u.chapter_ids?.length) return u.chapter_ids;
	if (u.chapter_id != null) return [u.chapter_id];
	return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Stats {
	total: number;
	skipped: number; // bots, deleted, no email
	noSolidarity: number;
	noChapterMapping: number;
	channelsInvited: number;
	alreadyInChannel: number;
	errors: number;
}

async function main() {
	if (DRY_RUN) console.log('*** DRY RUN — no changes will be made ***\n');

	const stats: Stats = {
		total: 0,
		skipped: 0,
		noSolidarity: 0,
		noChapterMapping: 0,
		channelsInvited: 0,
		alreadyInChannel: 0,
		errors: 0,
	};

	// Paginate through all workspace members
	let cursor: string | undefined;
	do {
		const page = await bot.users.list({ limit: 200, cursor });
		cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? undefined;
		if (!cursor) cursor = undefined;

		const members = (page.members ?? []) as Array<{
			id: string;
			is_bot?: boolean;
			deleted?: boolean;
			profile?: { email?: string };
		}>;

		for (const member of members) {
			stats.total++;

			if (member.is_bot || member.deleted || !member.id) {
				stats.skipped++;
				continue;
			}

			// Fetch full profile to get email (users.list doesn't always include it)
			const info = await bot.users.info({ user: member.id });
			const email = (info.user as { profile?: { email?: string } } | undefined)?.profile?.email;

			if (!email) {
				stats.skipped++;
				continue;
			}

			console.log(`Processing ${email} (${member.id})`);

			const solidarityUser = await getSolidarityUser(email);
			if (!solidarityUser) {
				console.log(`  no Solidarity account found`);
				stats.noSolidarity++;
				// Pace Solidarity API calls: ~2 req/s max
				await sleep(500);
				continue;
			}

			// --- Channel invites ---
			const chapterIds = chapterIdsFor(solidarityUser);
			const channelIds = chapterIds
				.map((id) => SOLIDARITY_CHAPTER_CHANNEL_MAP[String(id)])
				.filter((id): id is string => Boolean(id));

			if (!channelIds.length) {
				console.log(`  chapters [${chapterIds.join(', ')}] — no channel mapping`);
				stats.noChapterMapping++;
			} else {
				for (const channelId of channelIds) {
					if (DRY_RUN) {
						console.log(`  [dry-run] would invite to ${channelId}`);
						stats.channelsInvited++;
						continue;
					}
					try {
						await bot.conversations.invite({ channel: channelId, users: member.id });
						console.log(`  invited to ${channelId}`);
						stats.channelsInvited++;
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						if (msg.includes('already_in_channel')) {
							stats.alreadyInChannel++;
						} else {
							console.error(`  failed to invite to ${channelId}: ${msg}`);
							stats.errors++;
						}
					}
				}
			}

			// Pace Solidarity API calls
			await sleep(500);
		}
	} while (cursor);

	console.log('\n--- Summary ---');
	console.log(`Total Slack users:       ${stats.total}`);
	console.log(`Skipped (bot/no email):  ${stats.skipped}`);
	console.log(`No Solidarity account:   ${stats.noSolidarity}`);
	console.log(`No chapter mapping:      ${stats.noChapterMapping}`);
	console.log(`Channel invites sent:    ${stats.channelsInvited}`);
	console.log(`Already in channel:      ${stats.alreadyInChannel}`);
	console.log(`Errors:                  ${stats.errors}`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});