import { json, text } from '@sveltejs/kit';
import { WebClient } from '@slack/web-api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { APP_URL } from '$lib/server/env.js';
import { loadSettings, findInfoCommand } from '$lib/server/settings.js';
import { verifySlackSignature } from '$lib/server/slack-signature.js';
import { isSlackAdmin, NOT_AUTHORIZED_TEXT } from '$lib/server/slack-admin.js';
import { buildNoteModal, parseCommandTarget } from '$lib/server/slack-modal.js';
import { channelNameToId } from '$lib/server/slack-channel-names.js';
import { loadUserToken, type TokenLookupFailure } from '$lib/server/user-tokens.js';
import { normalizeCommandName, renderInfoMessage } from '$lib/info-command.js';
import { respondToSlack } from '$lib/server/slack-response-url.js';
import { turfListMessage } from '$lib/server/van/turf-slack.js';
import { errMessage } from '$lib/err-message.js';

// Slash commands. Three kinds:
//
//   /member-note          — opens the note/warning modal (see slack-modal.ts)
//   /turfs                — nearest available turf, claimable in place
//                           (see van/turf-slack.ts)
//   anything else         — looked up in `info_commands`, the admin-defined
//                           blurbs, and posted **as the person who typed it**
//
// /turfs is the ONLY command here open to non-admins, and deliberately so: it
// serves the same data the /turfs web page serves, and that page is open to any
// signed-in workspace member minus the turf blocklist. A Slack workspace member
// is the same bar as a Slack-OAuth session, so this grants nothing new. Its
// gates are van/turf-slack.ts's, not this file's.
//
// Two things differ from the events route: Slack sends slash commands as
// `application/x-www-form-urlencoded` (so the body is parsed with
// URLSearchParams, not JSON.parse), and those requests carry no Origin header —
// which is why /api/slack/* is exempt from the CSRF check in
// src/lib/server/csrf.ts. The signature verification below is what replaces it.

const LOG = '[info-command]';
const TURF_LOG = '[van]';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.text();

	if (!(await verifySlackSignature(request, body))) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const form = new URLSearchParams(body);
	const command = form.get('command') ?? '';
	const slackUserId = form.get('user_id') ?? '';
	const triggerId = form.get('trigger_id') ?? '';
	const channelId = form.get('channel_id');
	const commandText = form.get('text') ?? '';
	const responseUrl = form.get('response_url');

	if (command === '/member-note') {
		return handleMemberNote({ slackUserId, triggerId, channelId, commandText });
	}

	if (command === '/turfs') {
		return handleTurfs({ slackUserId, channelId, commandText, responseUrl });
	}

	return handleInfoCommand({ command, slackUserId, channelId });
};

// ---------------------------------------------------------------------------
// /turfs
// ---------------------------------------------------------------------------

/**
 * Acknowledge now, answer in a moment.
 *
 * Unlike /member-note this cannot be done inside Slack's three seconds. A cold
 * geocode is up to four on its own (zip-centroid.ts), and fly.toml still has
 * min_machines_running = 0, so a boot can land on top of it.
 *
 * The follow-up asks to replace the ack rather than sit below it. Slack's
 * support for `replace_original` on a slash command's first ephemeral is not
 * something to bet on, so the failure mode is deliberately benign: if it does
 * not take, the answer simply appears under "Finding turf near you…" instead
 * of over it.
 */
function handleTurfs(args: {
	slackUserId: string;
	channelId: string | null;
	commandText: string;
	responseUrl: string | null;
}): Response {
	const { slackUserId, channelId, commandText, responseUrl } = args;

	void (async () => {
		const message = await turfListMessage(db, {
			slackUserId,
			channelId,
			argument: commandText,
		});
		respondToSlack(responseUrl, message, { replaceOriginal: true, logTag: TURF_LOG });
	})().catch((err) => {
		console.error(`${TURF_LOG} /turfs failed for ${slackUserId}:`, errMessage(err));
		respondToSlack(
			responseUrl,
			{ text: 'Could not look up turf just now. Please try again.' },
			{ replaceOriginal: true, logTag: TURF_LOG },
		);
	});

	return ephemeral(commandText.trim() ? 'Finding turf near you…' : 'Finding turf…');
}

// ---------------------------------------------------------------------------
// /member-note
// ---------------------------------------------------------------------------

async function handleMemberNote(args: {
	slackUserId: string;
	triggerId: string;
	channelId: string | null;
	commandText: string;
}): Promise<Response> {
	const { slackUserId, triggerId, channelId, commandText } = args;

	if (!(await isSlackAdmin(slackUserId))) {
		// 200 with an ephemeral body — only the person who typed it sees this.
		return ephemeral(NOT_AUTHORIZED_TEXT);
	}

	if (!triggerId) {
		return ephemeral('Slack did not send a trigger id, so the dialog cannot be opened.');
	}

	// Awaited rather than fire-and-forget: this is a single ~200ms call, well
	// inside Slack's 3-second budget, and if it fails the admin needs to be told
	// rather than left staring at nothing. The trigger_id also expires in about
	// three seconds, so there is nothing to gain by deferring it.
	try {
		const { warningDmMessage } = await loadSettings(db);
		await slack.views.open({
			trigger_id: triggerId,
			view: buildNoteModal(
				// `<@U123|name>` only arrives if "Escape channels, users, and
				// links" is enabled on the command; without it we simply open
				// the modal with no member preselected.
				{ slackUserId: parseCommandTarget(commandText) },
				{ channelId, source: 'slash', warningTemplate: warningDmMessage },
			),
		});
	} catch (err) {
		console.error('[member-note] views.open failed:', errMessage(err));
		return ephemeral('Could not open the note dialog. Please try again.');
	}

	// Empty 200 — the modal is the response; echoing text would just clutter
	// the channel.
	return text('', { status: 200 });
}

// ---------------------------------------------------------------------------
// Admin-defined info commands
// ---------------------------------------------------------------------------

async function handleInfoCommand(args: {
	command: string;
	slackUserId: string;
	channelId: string | null;
}): Promise<Response> {
	const { slackUserId, channelId } = args;
	// Slack always sends the command lowercase and slash-prefixed, but the rows
	// are keyed on the normalized form, so normalize both sides rather than
	// trusting that to stay true.
	const command = normalizeCommandName(args.command);

	let entry;
	try {
		entry = await findInfoCommand(db, command);
	} catch (err) {
		console.error(`${LOG} lookup failed for ${command}:`, errMessage(err));
		return ephemeral('Could not look that command up. Please try again.');
	}

	if (!entry) {
		console.warn(`${LOG} unrecognized command "${command}"`);
		return ephemeral('Unrecognized command.');
	}

	// Same gate as /member-note. It is also the only gate that can work today:
	// a token is stored only for admins (see auth/slack/callback), so a
	// non-admin has nothing to post with.
	if (!(await isSlackAdmin(slackUserId))) {
		return ephemeral(NOT_AUTHORIZED_TEXT);
	}

	if (!channelId) {
		return ephemeral('Slack did not say which channel to post in.');
	}

	const lookup = await loadUserToken(db, slackUserId);
	if (!lookup.ok) {
		return ephemeral(reauthorizeMessage(lookup.reason));
	}

	// Channel links are resolved with the *bot* client: it is the one with
	// channels:read, and the cached list is shared with the DM templates.
	// Failing to resolve is non-fatal — names stay literal (see
	// channelNameToId), which is better than not posting at all.
	const message = renderInfoMessage(entry.message, await channelNameToId('info-command'));

	try {
		// A per-request client, not the shared bot `slack` proxy: this call must
		// carry the user's own token, which is the entire point — the message
		// lands as theirs, editable and deletable by them, with no APP badge.
		await new WebClient(lookup.token).chat.postMessage({
			channel: channelId,
			text: message,
			// No `blocks`: a section block would render the same text but strip
			// the message of its plain-text fallback in notifications, and
			// there is no structure here worth the tradeoff.
			unfurl_links: false,
		});
	} catch (err) {
		const detail = errMessage(err);
		console.error(`${LOG} ${command} post as ${slackUserId} failed:`, detail);
		return ephemeral(postFailureMessage(detail));
	}

	console.log(`${LOG} ${command} posted as ${slackUserId} in ${channelId}`);
	// Empty 200 — the posted message is the response.
	return text('', { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ephemeral(message: string): Response {
	return json({ response_type: 'ephemeral', text: message });
}

/** All four lookup failures are fixed by logging in again, so they share a
 *  call to action and differ only in why. */
function reauthorizeMessage(reason: TokenLookupFailure): string {
	const authorize = `${APP_URL}/auth/slack`;
	switch (reason) {
		case 'stale-scope':
			return (
				'This command posts as you, and your Slack authorization predates that. ' +
				`Sign in again at ${authorize} to grant it, then retry.`
			);
		case 'unreadable':
		case 'error':
			return (
				'Your stored Slack authorization could not be read. ' +
				`Sign in again at ${authorize} to refresh it, then retry.`
			);
		case 'missing':
		default:
			return (
				'This command posts as you, so it needs your authorization first. ' +
				`Sign in at ${authorize}, then retry.`
			);
	}
}

/** Turn the two Slack errors an admin can actually act on into instructions,
 *  and pass anything else through so the failure isn't silent. */
function postFailureMessage(detail: string): string {
	if (detail.includes('not_in_channel')) {
		return 'You need to be a member of this channel to post here.';
	}
	if (detail.includes('token_revoked') || detail.includes('invalid_auth')) {
		return (
			'Slack rejected your stored authorization — it may have been revoked. ' +
			`Sign in again at ${APP_URL}/auth/slack, then retry.`
		);
	}
	return `Could not post the message: ${detail}`;
}
