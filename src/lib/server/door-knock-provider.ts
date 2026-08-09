// The seam between "where door-knock numbers come from" and everything the
// dashboard does with them.
//
// A provider's whole job is: given an instant, hand back the campaign day's
// totals — per turf and per canvasser. runDoorKnockSnapshot (door-knock-
// snapshot.ts) writes those rows and knows nothing else; the read side
// (door-knock-leaderboard, door-knock-ticker, door-knock-projection,
// dashboard-signups) only ever sees the tables.
//
// The seam sits HERE, at a day's rows, rather than one level down at a
// canvassing-tool API client, because the steps in between are tool-specific
// all the way through. Openfield's are: read conversation codes off a Slack
// canvas, POST each to /codes/ for a numeric id, GET each id's today-only
// leaderboard, then sweep codes that left the canvas mid-day. None of that
// survives a move to another tool — MiniVAN has turf exports and dated contact
// history instead — but "here are today's rows per turf and per person" does.
//
// Adding a provider means implementing these two methods and registering it in
// door-knock-env.ts. It does NOT mean touching the snapshot writer, the
// refresh throttle, the schema, or any chart.
//
// No $env/$lib imports — providers are constructed by door-knock-env.ts.

/** Chart band for turfs the provider couldn't attribute to a chapter. Its
 *  presence on the board is a signal that whatever supplies the chapter
 *  mapping (for Openfield, the Slack canvas parser) has drifted. */
export const UNMAPPED_CHAPTER = 'Unmapped';

/** A turf's total for the day. `code` is the provider's own identifier for the
 *  unit of canvassing — an Openfield conversation code, a MiniVAN turf export
 *  name — and is opaque to everything downstream except as half of the
 *  (date, code) primary key. */
export interface TurfDayRow {
	code: string;
	chapterName: string;
	attempts: number;
	contacts: number;
}

/** One person's total on one turf for the day. Names are already trimmed and
 *  de-duplicated by the provider: '' would collide on the
 *  (date, code, canvasser) primary key. */
export interface CanvasserDayRow {
	code: string;
	chapterName: string;
	canvasser: string;
	attempts: number;
	contacts: number;
}

export interface DoorKnockDayRows {
	/** The campaign day these rows belong to, stamped in the provider's own
	 *  rollover zone (see `dateFor`). */
	date: string;
	perTurf: TurfDayRow[];
	perCanvasser: CanvasserDayRow[];
	/** Human-readable problems worth waking someone for — posted verbatim to
	 *  the tracking channel by the scheduled snapshot endpoint. The provider
	 *  writes the whole message because only it knows what the problem means.
	 *  Routine conditions (an Openfield mid-day code swap) belong in the log,
	 *  not here: a warning fires a Slack ping. */
	warnings: string[];
	/** Provider-shaped run detail — returned in the snapshot's JSON response
	 *  and logged, never interpreted. */
	details: Record<string, unknown>;
}

export interface DoorKnockProvider {
	/** Short identifier for logs and the snapshot result ('openfield'). */
	readonly name: string;
	/** The campaign day an instant falls in. This is the provider's call, not
	 *  the campaign's timezone: it must match the rollover of whatever the
	 *  provider reads, or a run near midnight stamps the wrong day. */
	dateFor(now: Date): string;
	/** Collect the day's totals. Throwing means "no usable data" and aborts
	 *  the snapshot without writing — never return a fabricated zero day. */
	collect(now: Date): Promise<DoorKnockDayRows>;
}
