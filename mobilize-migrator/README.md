# Solidarity → Mobilize event migrator

Ports upcoming in-person Solidarity events into Mobilize.

```bash
npx tsx mobilize-migrator/migrate.ts           # dry run (default) — prints the plan, writes private/migration-plan.json
npx tsx mobilize-migrator/migrate.ts --apply   # create new events and push edits to existing ones
npx tsx mobilize-migrator/migrate.ts --apply --limit 5
```

`migrate.ts` is a thin wrapper over `lib/sync.ts` — the same engine the scheduled
endpoint runs, with a JSON-file ledger instead of Turso. It previously had its own
copy of the create loop and silently missed everything added to the shared one
(timeslot pairings, image upload, updates), so there is deliberately only one
implementation now.

The CLI and the endpoint share the **same Turso ledger**, so they can never
disagree about what has already been created — running one after the other is
safe. The CLI therefore needs `TURSO_DATABASE_URL` (and `TURSO_AUTH_TOKEN`) in
`.env.local` alongside the Mobilize cookie. Prefer the endpoint for scheduled
work; the CLI is for dry runs and inspection.

Dry run is the default deliberately: created events are publicly visible and there
is no bulk undo.

## Credentials

Both go in `.env.local`:

| Variable | Purpose |
| --- | --- |
| `SOLIDARITY_API_TOKEN` | Already used elsewhere in this repo; read side. |
| `MOBILIZE_COOKIE` | The `Cookie` header from a logged-in mobilize.us dashboard request. Required — there is no fallback. |
| `MOBILIZE_CSRF_TOKEN` | Optional — derived from `csrftoken=` inside the cookie if omitted. |

Only `sessionid` and `csrftoken` are actually needed, so the minimal value is:

```
MOBILIZE_COOKIE='sessionid=…; csrftoken=…'
```

Mobilize has **no public write API**. Event creation goes through the same private
`/_/api/organization/<slug>/events/` endpoint the dashboard's create form posts to,
which means borrowing a logged-in browser session. That session is short-lived: when
a run starts failing with 403, open the dashboard, copy a fresh `Cookie` header from
DevTools → Network, and re-run. Progress is saved, so a re-run resumes rather than
duplicating.

> The captured dashboard requests this was reverse-engineered from live in
> **`private/`**, which is gitignored wholesale. They carry live session cookies,
> and `event-rsvps.json` also holds real attendees' names, emails, phone numbers
> and zip codes. Put anything else that must not leave the machine there too —
> generated run artifacts already go there.

## How it maps

**The shape mismatch.** A Solidarity event owns many *sessions*, and each session
carries its own location and time. A Mobilize event has *one* address plus many
timeslots. So sessions are grouped by location, and one Solidarity event can become
several Mobilize events — "Operation Get Out the Vote" (Flint, Grand Rapids, Detroit,
Oakland, Ann Arbor) becomes five.

**Times.** Solidarity returns absolute instants but renders them with an
*inconsistent* UTC offset — the same session came back as both `...T18:00:00-06:00`
and `...T20:00:00-04:00` across two calls. Never read the wall time off the string.
`lib/time.ts` parses to an instant and re-renders it in `America/New_York`. (Michigan
is `America/Detroit`, but Mobilize validates `timezone` against a fixed list that
rejects it; the offsets and DST rules are identical.) Verified against the public
event page, which shows "Thursday, July 30th at 8:00 pm" for the `-04:00` rendering.

**Addresses.** Most sessions leave Solidarity's structured `location_data`
components blank and carry only a Google-formatted `location_address` string plus
coordinates, so `lib/address.ts` parses that string. City-only addresses ("Ann Arbor,
MI, USA") are *rejected* rather than migrated — Mobilize would drop a pin on the city
centroid, which is worse than a missing event a human can add correctly.

**Descriptions.** `/v1/events` returns a *flattened plain-text* description — the
bold, links and lists on the event page are stripped before we see them. The real
content is on the linked ActionPage (`/v1/pages/{event_page_id}`) as HTML, so
`lib/html-to-markdown.ts` converts that to Markdown, which is what Mobilize
renders ([help.mobilize.us](https://help.mobilize.us/en/articles/4196288-how-to-use-markdown-in-mobilize)).

Do **not** send HTML: Mobilize stores the description verbatim, and none of the
campaign's hand-written descriptions contain a tag — raw HTML would show
volunteers literal `<p style="…">`. Two rules drive the output: blocks need a
blank line between them or they collapse onto one line, and a line break inside a
paragraph needs two trailing spaces. Events with no rich page fall back to the
flattened text with its single newlines promoted to real paragraph breaks.

Events already in Mobilize get this applied by the sync's update pass, which
re-sends the event via PUT whenever the rendered description differs.

**Images.** Mobilize will not accept a foreign `image_url` — the bytes have to be
re-hosted in its own bucket first:

| URL | Result |
| --- | --- |
| `s3.amazonaws.com/solidarity.tech/…` | `400 Invalid URL.` |
| same, query string removed | `400 Invalid URL.` |
| `mobilizeamerica.imgix.net/…` (Mobilize's own CDN) | `400 Invalid URL.` |
| `mobilize-uploads-prod.s3.…amazonaws.com/…` | **accepted** |

`lib/image.ts` reproduces the three-step dashboard flow:

1. `GET /_/api/s3/publicimage/?file_name=…&file_mimetype=…&resource=event` →
   `{"data":{"url":"https://mobilize-uploads-prod.s3.us-east-2.amazonaws.com/uploads/event/<slug>_<timestamp>.<ext>?X-Amz-Signature=…"}}`.
   A **GET with query parameters**, not a POST body; Mobilize holds the AWS
   credentials and appends the timestamp itself.
2. `PUT` the bytes to that signed URL with `x-amz-acl: public-read` and the right
   `Content-Type`. (The browser also sends a CORS preflight `OPTIONS` here — that's
   automatic in the browser and unnecessary from Node.)
3. Set `image_url` to the **same URL with its query string stripped**, then PUT the
   event.

The sync does this as part of creating an event, and backfills it on the update
pass for any event that still has no image. Uploads are recorded in
`mobilize_synced_images`, keyed by the Solidarity URL, so a shared image is
uploaded once and reused — 53 events were covered by 38 distinct uploads. Events
that already have an image are left alone.

**Event types.** The private API takes numeric codes. They aren't documented and
aren't readable (GET/OPTIONS both 405, Cloudflare blocks the JS bundle), so they were
confirmed empirically: create a throwaway event far in the future with a candidate
code, read the type name back off the *public* API, then delete it.

```
5 COMMUNITY   18 OFFICE_OPENING   19 BARNSTORM   20 SOLIDARITY_EVENT
21 COMMUNITY_CANVASS   22 SIGNATURE_GATHERING   23 CARPOOL
```

Only `COMMUNITY` and `COMMUNITY_CANVASS` are used. Solidarity has no structured
"is this a canvass" flag, so classification is by title/description keyword
(`canvass`, `knock`, `door`, …). The dry run prints the choice per event.

**Skipped.** Virtual events (they need a join URL the list payload doesn't expose),
co-hosted mirrors of another org's event, past sessions, and anything without a
usable street address.

## Not creating duplicates

Two independent mechanisms:

1. **The `mobilize_synced_events` ledger** — a row for every event the sync
   created, keyed by Solidarity event + location, written after *each* success.
   A crash or expired session mid-run never causes a repeat.
2. **Heuristic matching** against Mobilize's public feed, for events created by hand.

Titles are not stable across the two systems — Solidarity's *"Marquette County Abdul
El-Sayed Canvass Launch & Debate Watch Party!"* is Mobilize's *"Abdul El-Sayed Canvass
Launch & Debate Watch Party in Negaunee!"* — so matching is: identical normalized
title, **or** a shared start time (±1h) plus agreeing cities plus title-token overlap.

The city guard matters more than the title score. The campaign runs the same
generically-named event in several cities on one night — "Debate Watch Party" in
Coldwater, Lansing, Pontiac and Oakland, all at 7:15pm — and title overlap alone
marks all of them as duplicates of each other.

## Running nightly

The scheduled path does not run this code in a GitHub runner. Following the same
pattern as `daily-snapshot.yml`, the workflow just `curl`s an authenticated
endpoint on the Fly app, so credentials and Turso stay where they already live:

```
.github/workflows/mobilize-sync.yml
  └─ POST /api/internal/mobilize-sync?key=$INTERNAL_CRON_SECRET
       └─ src/lib/server/mobilize-sync.ts   (Turso-backed ledger)
            └─ mobilize-migrator/lib/sync.ts   (shared with the CLI)
```

`lib/*` stays free of `$env` and `node:fs` so both entry points can use it —
state arrives through a `Ledger` interface, credentials through `SyncConfig`.
Same dual-use trick as `src/lib/server/solidarity-paginate.ts`.

### Rollout

1. `npm run db:migrate` — creates the ledger tables.
2. `fly secrets set MOBILIZE_COOKIE='sessionid=…; csrftoken=…'`
3. Verify without writing: `POST /api/internal/mobilize-sync?key=…&dry=1`, or run
   the workflow manually with **dry run** ticked.

*(The initial backfill of 88 events and its one-time JSON→Turso seed are done;
those files have been removed. The ledger now lives only in Turso.)*

### What it does each night

Full sync: creates events new to Solidarity, and pushes edits — title, times,
description, image — onto ones already mirrored. Events created by hand in
Mobilize are matched by the duplicate heuristic and left alone.

Two behaviours worth knowing:

- **Manual edits in Mobilize get overwritten.** If an organizer fixes a
  description there, the next run replaces it with Solidarity's. Solidarity is
  the source of truth by design; edit it there.
- **Shifts are never deleted.** Mobilize destroys a timeslot — and its signups —
  if it's absent from a PUT. So live shifts with no Solidarity counterpart
  (cancelled sessions, past shifts) are re-sent untouched rather than dropped. A
  cancelled session therefore needs removing by hand. Leaving a stale shift is
  strictly better than deleting one people signed up for.

### The guardrail

If a night's plan wants more than `MOBILIZE_SYNC_MAX_CREATES` (default 25) new
events, it creates **nothing** and alerts. A flood means dedup broke or the
source data changed shape, and these events are public the moment they exist.
Clear it deliberately with `?maxCreates=N` or the workflow input.

### When it breaks

`MOBILIZE_COOKIE` is a borrowed browser session. Mobilize has no public write API
and no machine credentials — login is by emailed code or Google OAuth, with no
password endpoint — so **it cannot be renewed programmatically**. Expect to
re-paste it roughly every two weeks (Django's default session age).

On expiry the endpoint returns 503, the workflow run goes red, and the app posts
a Slack alert with the fix to the growth-report channel — the DB override set in
/settings if there is one, otherwise `SLACK_GROWTH_REPORT_CHANNEL_ID`, resolved
the same way the weekly report resolves it. Only `sessionid` and
`csrftoken` are needed — the Cloudflare `__cf_bm` cookie in a captured header is
not, which is what makes a stored secret viable at all.

If this fragility becomes a problem, the durable fix is asking Mobilize for
partner API access, which would replace the whole borrowed-session layer with a
real token.

## Attendee sync (Mobilize → Solidarity)

The reverse direction: Mobilize signups become RSVPs on the matching Solidarity
event session, so organizers only check one place.

```bash
# Inspect the match rate on a real shift before trusting it with the CRM
npx tsx mobilize-migrator/attendee-sync.ts --timeslot 6157028 --session 80929 --event 27463
```

Scheduled via `.github/workflows/attendee-sync.yml` →
`POST /api/internal/attendee-sync` (`?dry=1`, `?window=<hours>`, `?maxProfiles=N`).

**Where the data comes from.** The campaign has no Mobilize API key, so the
documented `/v1/organizations/{id}/attendances` endpoint is unavailable. Instead
`lib/attendees.ts` reads the dashboard's own per-timeslot route with the borrowed
session — `GET /dashboard/<org>/timeslot/<id>/?page=N` with
`Accept: application/json`, 25 rows a page under `data.participations`.

**Status codes are numeric and undocumented.** Decoded by cross-checking a real
shift against its own `participant_count`: 81 signups split 77 registered / 4
cancelled, and the rows split exactly 77 × `status: 1` and 4 × `status: 2`. So
**1 = REGISTERED, 2 = CANCELLED**. `CONFIRMED` has its own counter but was zero
everywhere observed, so its value is still unknown — anything unrecognized is
skipped and alerted rather than guessed, because mapping it wrong would mark
real attendees as cancelled.

| Mobilize | Solidarity |
| --- | --- |
| `status: 1` (registered) | RSVP `is_attending: "yes"` |
| `status: 2` (cancelled) | existing RSVP set to `"no"` — never deleted |
| `volunteer_check_in` set | plus an `event_attendances` record |

### Traps, all verified against the live API

- **`?phone=` is silently ignored** by `/v1/users` — it returns an *unfiltered*
  list, so matching on it attaches signups to arbitrary strangers. The real
  parameter is **`phone_number`**. There is a regression test asserting the
  query string; don't "simplify" it.
- **Paths use underscores**: `/v1/event_rsvps`, `/v1/event_attendances`. The
  hyphenated forms in the docs URLs 404.
- **`event_id` here means a *Solidarity* event.** Solidarity calls its own event
  entity a "mobilize_event" — its sessions carry `mobilize_event_id` pointing at
  a Solidarity event. Nothing to do with mobilize.us.
- **`skip_email_confirmation: true`** on every RSVP write, or Solidarity emails a
  confirmation to everyone the sync touches.
- A lookup returning **more than one** person resolves to no match. Picking the
  first would file an RSVP against the wrong human.

### New profiles

`chapter_id` is required and Solidarity chapters have no geographic data, so
zip → chapter is derived from where existing members actually sit (per zip, the
most common chapter), rebuilt on the nightly pass. Falls back to the chapter
owning the event, then `SOLIDARITY_DEFAULT_CHAPTER_ID`; if none resolves, the
person is reported rather than filed under a guess.

Only `sms_permission` is set, mirroring Mobilize's opt-in. Call and email
permission are left alone — signing up for an event is not consent to be called.

**Guardrail:** a run creating more than `ATTENDEE_SYNC_MAX_NEW_PROFILES`
(default 50) profiles stops and alerts. A spike almost always means matching
broke, and duplicate people are tedious to unpick (`POST /v1/users/merge` is the
remedy).

Expect a real match rate well under 100%: on a sampled shift, 26 of 81 signups
already existed, and spot-checking 10 of the other 55 confirmed all were
genuinely absent. Mobilize reaches people the CRM hasn't seen — that's the point
of the sync — so judge a run by *change* in the rate, not its absolute value.

### Cadence

Every 30 minutes with a **4.5-hour look-ahead**, plus a nightly windowless pass
so events further out still get a rolling picture rather than their signups only
landing 4.5h before doors.

The ask was "4 hours before, and again 30 minutes before". GitHub cron cannot hit
fixed offsets — it is best-effort and this repo documents delays of hours
(`door-knock-snapshot.yml`). A look-ahead *window* covers both marks and
tolerates a skipped run, because the next one still refreshes the event in time.

Both passes also look **back 48 hours** (`?lookback=`). Check-ins are recorded
during and after an event, so a forward-only scope would never sync who actually
showed up.

**Why the window is bounded.** Every session in scope costs at least one Mobilize
dashboard request, and the ledger cannot skip it — we have to fetch to learn
whether anything changed. Measured on the current calendar:

| Scope | Sessions | Requests/run | Per day at `*/30` |
| --- | --- | --- | --- |
| 4.5h window | 0–30 | ≤30 | ~1,400 |
| windowless | 176 | 176 | ~8,400 |

That traffic goes through a borrowed browser session behind the same Cloudflare
that rate-limits (error 1015) on bursts, and losing the session breaks the event
sync too. Hence a bounded window frequently, windowless once a night.

Solidarity's own 60-requests/30s limit sets the pacing (600ms between people).
Ledgered signups make no API calls at all, so the first full run is by far the
slowest.

The zip → chapter map rebuilds whenever it is more than a day old rather than on
its own schedule, so neither cron entry is special-cased.

## Tests

```bash
npx vitest run mobilize-migrator
```

Covers the two places a bug writes bad data: time conversion (including the
inconsistent-offset case and EST/EDT) and duplicate detection.
