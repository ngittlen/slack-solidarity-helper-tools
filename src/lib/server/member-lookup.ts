// Resolves one Slack member into the view the /members page renders: who they
// are, which Solidarity account (if any) they map to, their recent activity,
// and their moderation history.
//
// Dependencies are injected rather than imported so the resolution order and
// the degradation behavior can be tested without a DB or the network.

import type { NormalizedActivity } from './activity-feed.js';
import type { MemberNoteRow } from './schema.js';
import { errMessage } from '../err-message.js';

const LOG = '[member-page]';

/** Why this member is (or isn't) attached to a Solidarity account. The page
 *  needs the distinction: "no such account" invites a manual link, whereas
 *  "the lookup failed" means try again later. */
export type LinkReason =
	'linked' | 'email' | 'no-slack-email' | 'no-solidarity-match' | 'lookup-failed';

export interface SlackMemberSummary {
	id: string;
	name: string;
	realName: string;
	/** Shown only in the unlinked states, where the admin needs it to match. */
	email: string;
}

export type FeedResult =
	| { ok: true; items: NormalizedActivity[]; totalCount: number | null; truncated: boolean }
	| { ok: false; error: string };

export interface MemberDetail {
	slack: SlackMemberSummary;
	link: {
		reason: LinkReason;
		solidarityUserId: number | null;
		/** Present when reason === 'linked'. */
		linkedByName?: string;
		linkedAt?: string;
	};
	/** Solidarity chapter names, alphabetical. Empty when the member has no
	 *  Solidarity account, belongs to no chapter, or the lookup failed — this is
	 *  a label on the header, not something worth a visible error. */
	chapters: string[];
	actions: FeedResult;
	rsvps: FeedResult;
	notes: MemberNoteRow[];
}

export interface ExistingLink {
	solidarityUserId: number;
	linkedByName: string;
	linkedAt: string;
}

export interface MemberLookupDeps {
	/** Slack directory entry, or null when the id isn't a current human member. */
	findSlackUser: (slackUserId: string) => Promise<SlackMemberSummary | null>;
	/** Admin-made link, if one exists. */
	findLink: (slackUserId: string) => Promise<ExistingLink | null>;
	/** Solidarity account whose email matches. Throws on a lookup failure —
	 *  null strictly means "no account with this email". */
	findByEmail: (email: string) => Promise<{ id: number } | null>;
	fetchActions: (solidarityUserId: number) => Promise<FeedResult>;
	fetchRsvps: (solidarityUserId: number) => Promise<FeedResult>;
	/** Chapter names for the header. */
	fetchChapters: (solidarityUserId: number) => Promise<string[]>;
	listNotes: (slackUserId: string) => Promise<MemberNoteRow[]>;
}

const FEED_UNAVAILABLE = 'Could not load this from Solidarity. Try again in a moment.';

export async function resolveMember(
	deps: MemberLookupDeps,
	slackUserId: string,
): Promise<MemberDetail | null> {
	const slack = await deps.findSlackUser(slackUserId);
	if (!slack) return null;

	// Notes are local and must load regardless of what Solidarity does — a
	// Solidarity outage cannot be allowed to hide someone's warning history.
	const notesPromise = deps.listNotes(slackUserId).catch((err) => {
		console.error(`${LOG} notes lookup failed for ${slackUserId}:`, errMessage(err));
		return [] as MemberNoteRow[];
	});

	const resolved = await resolveSolidarityId(deps, slack);

	let actions: FeedResult = { ok: false, error: FEED_UNAVAILABLE };
	let rsvps: FeedResult = { ok: false, error: FEED_UNAVAILABLE };
	let chapters: string[] = [];

	if (resolved.solidarityUserId !== null) {
		// Independent so one failing lookup still leaves the others rendered.
		const [actionsResult, rsvpsResult, chaptersResult] = await Promise.allSettled([
			deps.fetchActions(resolved.solidarityUserId),
			deps.fetchRsvps(resolved.solidarityUserId),
			deps.fetchChapters(resolved.solidarityUserId),
		]);
		actions = settledFeed(actionsResult, 'user actions', slackUserId);
		rsvps = settledFeed(rsvpsResult, 'event RSVPs', slackUserId);
		if (chaptersResult.status === 'fulfilled') {
			chapters = chaptersResult.value;
		} else {
			// No visible error: the chapter line is context, and an admin who came
			// here for someone's activity and notes still gets both.
			console.error(
				`${LOG} chapter lookup failed for ${slackUserId}:`,
				errMessage(chaptersResult.reason),
			);
		}
	}

	return { slack, link: resolved, chapters, actions, rsvps, notes: await notesPromise };
}

function settledFeed(
	result: PromiseSettledResult<FeedResult>,
	label: string,
	slackUserId: string,
): FeedResult {
	if (result.status === 'fulfilled') return result.value;
	console.error(`${LOG} ${label} failed for ${slackUserId}:`, errMessage(result.reason));
	return { ok: false, error: FEED_UNAVAILABLE };
}

/**
 * A manual link wins over an email match, always.
 *
 * The order matters: an admin linking these accounts by hand is an explicit
 * decision about a case the email heuristic already got wrong. If email were
 * checked first, a member later correcting their Solidarity address would
 * silently start resolving to a different record than the one that was chosen
 * for them.
 */
async function resolveSolidarityId(
	deps: MemberLookupDeps,
	slack: SlackMemberSummary,
): Promise<MemberDetail['link']> {
	const link = await deps.findLink(slack.id).catch((err) => {
		console.error(`${LOG} link lookup failed for ${slack.id}:`, errMessage(err));
		return null;
	});
	if (link) {
		return {
			reason: 'linked',
			solidarityUserId: link.solidarityUserId,
			linkedByName: link.linkedByName,
			linkedAt: link.linkedAt,
		};
	}

	if (!slack.email) {
		return { reason: 'no-slack-email', solidarityUserId: null };
	}

	try {
		const found = await deps.findByEmail(slack.email);
		return found
			? { reason: 'email', solidarityUserId: found.id }
			: { reason: 'no-solidarity-match', solidarityUserId: null };
	} catch (err) {
		// Distinct from "no match": the page must not invite the admin to
		// hand-link someone just because Solidarity was briefly down.
		console.error(`${LOG} email lookup failed for ${slack.email}:`, errMessage(err));
		return { reason: 'lookup-failed', solidarityUserId: null };
	}
}
