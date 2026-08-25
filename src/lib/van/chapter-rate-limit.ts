// How often one person may switch which chapter's turf they are looking at.
//
// The chapter picker is open by design — volunteers regularly canvass outside
// the county they live in, so gating on their Solidarity home chapter would
// lock out exactly the people travelling to help. The cost of that openness is
// that anyone patient can page through every county and reconstruct the whole
// field picture.
//
// This does not stop them, and is not meant to. It makes enumeration slow and
// noisy instead of a loop: a handful of switches an hour is generous for
// someone actually canvassing and useless for someone scraping, and every
// refusal is a log line with a Slack user id on it. Compartmentalisation, not
// access control — see plan.md §3, which is explicit that this is the
// distinction.
//
// Pure apart from the store it is handed, so the window arithmetic is testable
// without a clock or a database.

/** Distinct chapters one user may open per window. */
export const MAX_CHAPTER_SWITCHES = 8;
export const WINDOW_MS = 60 * 60 * 1000;

/**
 * Distinct chapters in a window before a view is worth a log line.
 *
 * Logging every chapter view produced a line each time a volunteer opened
 * their own county — which is most of the traffic, carries no information, and
 * buries the handful of lines that matter. One or two chapters is what using
 * the feature looks like; four in an hour is not, and that is where the log
 * starts.
 *
 * What this trades away, stated plainly: someone who paces themselves under
 * the threshold and waits out each window can browse invisibly, at three
 * chapters an hour. The rate limit above still caps them at eight, so this
 * buys quiet at the cost of catching only the impatient. That is the right
 * trade for a compartment that §3 already calls effort-raising rather than
 * access control — but it is a trade, not a free win.
 */
export const CHAPTER_LOG_THRESHOLD = 4;

export interface ChapterVisit {
	chapterId: number;
	at: number;
}

export type VisitLog = Map<string, ChapterVisit[]>;

export interface RateLimitDecision {
	allowed: boolean;
	/** Seconds until the oldest visit falls out of the window. Only meaningful
	 *  when `allowed` is false — it is what the page tells the volunteer. */
	retryAfterSeconds: number;
	/** How many distinct chapters this user has opened in the window, counting
	 *  this one. Included in the log line so a single entry carries what a
	 *  run of them used to. */
	distinctChapters: number;
	/** True when this view is worth recording: a chapter the user had not
	 *  already opened this window, and enough of them to be unusual. Computed
	 *  here rather than in the route so the threshold is testable and the two
	 *  callers cannot disagree about it. */
	shouldLog: boolean;
}

/**
 * Record a chapter view and say whether it was allowed.
 *
 * Re-opening a chapter you already looked at this window is free. That matters
 * more than it sounds: a volunteer refreshing their own county's page, or
 * bouncing between the map and a claim, is not enumerating anything, and a
 * limiter that counted page views would throttle the one person using the
 * feature properly while barely inconveniencing a script.
 */
export function recordChapterView(
	log: VisitLog,
	slackUserId: string,
	chapterId: number,
	now: number,
): RateLimitDecision {
	const cutoff = now - WINDOW_MS;
	const recent = (log.get(slackUserId) ?? []).filter((v) => v.at > cutoff);

	const seen = recent.find((v) => v.chapterId === chapterId);
	if (seen) {
		// Refresh the timestamp so an active session doesn't age out of its own
		// chapter and get charged for it again.
		seen.at = now;
		log.set(slackUserId, recent);
		// Never logged. Re-opening a chapter you are already working in is the
		// single most common request this page serves.
		return {
			allowed: true,
			retryAfterSeconds: 0,
			distinctChapters: recent.length,
			shouldLog: false,
		};
	}

	if (recent.length >= MAX_CHAPTER_SWITCHES) {
		log.set(slackUserId, recent);
		const oldest = Math.min(...recent.map((v) => v.at));
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
			distinctChapters: recent.length,
			// The refusal is logged by the caller regardless — a rate-limited
			// request is always worth a line.
			shouldLog: false,
		};
	}

	recent.push({ chapterId, at: now });
	log.set(slackUserId, recent);
	return {
		allowed: true,
		retryAfterSeconds: 0,
		distinctChapters: recent.length,
		shouldLog: recent.length >= CHAPTER_LOG_THRESHOLD,
	};
}

/** Chapters this user has opened in the current window, oldest first. Used to
 *  make one log line as informative as the run of lines it replaces. */
export function chaptersSeen(log: VisitLog, slackUserId: string, now: number): number[] {
	const cutoff = now - WINDOW_MS;
	return (log.get(slackUserId) ?? [])
		.filter((v) => v.at > cutoff)
		.sort((a, b) => a.at - b.at)
		.map((v) => v.chapterId);
}

/** Drop users whose visits have all aged out, so a long-running process does
 *  not accumulate one entry per person who ever used the page. */
export function pruneVisitLog(log: VisitLog, now: number): void {
	const cutoff = now - WINDOW_MS;
	for (const [user, visits] of log) {
		const recent = visits.filter((v) => v.at > cutoff);
		if (recent.length === 0) log.delete(user);
		else log.set(user, recent);
	}
}
