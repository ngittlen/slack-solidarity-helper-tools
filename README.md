# slack-solidarity-helper-tools

A Slack bot and webhook server for solidarity.tech organisations. It does four things:

- **Welcome new members** — when someone joins the Slack workspace, the bot looks up their solidarity.tech account, automatically adds them to their county chapter channel(s), and sends them a DM with a link to those channels.
- **Help volunteers join Slack** — when a volunteer has trouble joining, solidarity.tech calls the webhook, their details are queued in a database, and admins work through the queue at `/pending` with live updates via Server-Sent Events.
- **Show signup trends** — every workspace member can sign in at `/` to see Solidarity vs. Slack signup charts over the last 7/30/90 days, with per-chapter drill-down at `/dashboard/solidarity` and `/dashboard/slack`.
- **Post a weekly growth report** — a scheduled internal endpoint computes per-chapter Slack-signup growth for the previous week and posts a Slack message highlighting the top performers.

## How it works

### New member welcome

1. A new member joins the Slack workspace
2. Slack sends a `team_join` event to `POST /api/slack/events`
3. The server looks up the member's email in solidarity.tech to find their chapter(s)
4. The bot invites them to the matching county channel(s) and sends them a DM:
   > *"Welcome to the workspace! We've added you to your county chapter channel: #county-name"*

### Volunteer invite queue

1. A volunteer indicates they need help joining Slack in a solidarity.tech automation
2. The automation calls `GET /webhook?secret=<WEBHOOK_SECRET>&email=<email>&name=<name>&phone=<phone>`
3. The server stores the volunteer's details in a Turso database and posts a message to a Slack channel
4. Authorised admins visit `/pending`, sign in with Slack, and see the queue update in real time
5. Admins mark volunteers as helped and add comments; changes are reflected live for all connected users

### Dashboard

1. Any workspace member signs in with Slack to land on `/`
2. The page renders two LayerChart bar charts — total Solidarity signups per day and total Slack signups per day — over a 7/30/90-day window (default 90, persisted via `?days=`)
3. A "View by chapter →" link on each card goes to `/dashboard/solidarity` or `/dashboard/slack`, which stacks bars per chapter with a top-10 + "Other" rollup
4. Chapters listed in `REPORT_EXCLUDED_CHAPTER_IDS` are omitted from both charts and from the weekly growth report
5. Data comes from local tables — `solidarity_daily_snapshots` (written nightly by `/api/internal/solidarity-snapshot`) and `slack_joins` (written in real time by the `team_join` handler)

### Weekly growth report

1. A scheduler (e.g. GitHub Actions) posts to `/api/internal/weekly-growth-report?key=<INTERNAL_CRON_SECRET>` once a week
2. The endpoint compares `slack_joins` rows from the last 7 days against the existing channel size (fetched via `conversations.info` for chapters with a `SOLIDARITY_CHAPTER_CHANNEL_MAP` entry, or the cumulative `slack_joins` count otherwise)
3. Chapters are ranked by a power-law score `newJoins / (existing + 1)^α` (configurable via `SLACK_GROWTH_REPORT_RANKING_ALPHA`, default `0.7`) and the top 5 are posted to `SLACK_GROWTH_REPORT_CHANNEL_ID`
4. Pass `?dry_run=1` to compute the result without posting

## Setup

### 1. Configure the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (or use an existing one)
2. Under **OAuth & Permissions**, add these bot scopes:
   - `chat:write` — to post messages and DMs
   - `im:write` — to open DM channels with new members
   - `channels:manage` — to invite members to public channels
   - `groups:write` — to invite members to private channels
   - `users:read` — to list workspace members
   - `users:read.email` — to read member email addresses
3. Under **OAuth & Permissions**, add this user scope:
   - `identity.basic` — for Sign in with Slack
4. Under **OAuth & Permissions → Redirect URLs**, add:
   ```
   https://your-app.fly.dev/auth/slack/callback
   ```
5. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`)
6. Invite the bot to each county channel it needs to post in: `/invite @your-bot-name`
7. Invite the bot to your tracking channel: `/invite @your-bot-name`
8. Copy the **Client ID**, **Client Secret**, and **Signing Secret** from **Basic Information**
9. Under **Event Subscriptions**, enable events and set the Request URL to:
   ```
   https://your-app.fly.dev/api/slack/events
   ```
   Then under **Subscribe to bot events**, add `team_join`

### 2. Find your Slack user IDs

For each person who should have access to `/pending`:
- Open their profile in Slack → **...** menu → **Copy member ID**

### 3. Create a Turso database

1. Sign up at [turso.tech](https://turso.tech) (free tier)
2. Create a new database:
   ```bash
   turso db create solidarity-slack
   ```
3. Get the connection URL and auth token:
   ```bash
   turso db show solidarity-slack --url
   turso db tokens create solidarity-slack
   ```

### 4. Build the chapter → channel map

Find the solidarity.tech chapter ID for each county and the corresponding Slack channel ID, then build a JSON object mapping one to the other.

To find a **chapter ID**: call `GET https://api.solidarity.tech/v1/chapters` with your API token and note the `id` field for each chapter.

To find a **Slack channel ID**: right-click the channel in Slack → **View channel details** → scroll to the bottom.

The resulting map looks like:
```json
{"123": "C012AB3CD", "456": "C987XY6Z"}
```

### 5. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your values:

```
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
SLACK_SIGNING_SECRET=your-signing-secret-here
SLACK_ALLOWED_USER_IDS=U012AB3CD,U012AB3CE
SLACK_TRACKING_CHANNEL_ID=C012AB3CD
SLACK_GROWTH_REPORT_CHANNEL_ID=C012AB3CD          # where the weekly growth report posts
SLACK_GROWTH_REPORT_RANKING_ALPHA=0.7             # optional; power-law exponent for ranking
REPORT_EXCLUDED_CHAPTER_IDS=123,456               # optional; chapters to omit from charts + report
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token-here
WEBHOOK_SECRET=your-webhook-secret-here
INTERNAL_CRON_SECRET=long-random-string           # required for /api/internal/* endpoints
APP_URL=https://your-app.fly.dev
SOLIDARITY_API_TOKEN=your-solidarity-api-token-here
SOLIDARITY_CHAPTER_CHANNEL_MAP='[{"chapterId":123,"channelId":"C012AB3CD","name":"Washtenaw County"}]'
COALITION_CHANNEL_MAP='{"labor":"C0ALZBGF9C2","housing":"C0ALZBGF9C3"}'
PORT=3000  # defaults to 3000 in production; ignored in dev (Vite uses 5173)
```

`SLACK_GROWTH_REPORT_RANKING_ALPHA` tunes the ranking formula `newJoins / (existing + 1)^α`. `α = 1` is pure relative growth (small chapters dominate); `α = 0` is pure absolute count; `0.7` is a middle ground where small chapters still tend to win but large ones can compete.

`REPORT_EXCLUDED_CHAPTER_IDS` is a comma-separated list of solidarity.tech chapter IDs to omit from the dashboard charts AND the weekly growth report — useful for test chapters or internal-only ones. Leave empty (or unset) to include everything.

`INTERNAL_CRON_SECRET` gates the scheduler-only endpoints under `/api/internal/`. Generate with `openssl rand -hex 32`.

### 6. Run the server

```bash
npm install

# Development (hot reload, http://localhost:5173)
npm run dev

# Run tests
npm test

# Production
npm run build
npm start

# Database migrations
npm run db:generate   # generate a new migration after editing src/lib/server/schema.ts
npm run db:migrate    # apply pending migrations to TURSO_DATABASE_URL
```

In production, migrations run via Fly's `release_command` (`node bin/migrate.js`) — see `fly.toml`. Each deploy applies any pending migrations before the new image starts serving traffic.

## Local development

A minimal `.env.local` for local development — no real Slack credentials needed:

```
TURSO_DATABASE_URL=file:local.db
WEBHOOK_SECRET=any-local-secret
DEV_SLACK_USER_ID=U012AB3CD
```

`file:local.db` creates a local SQLite database in the project root (no Turso account needed). `DEV_SLACK_USER_ID` bypasses Slack OAuth — visiting `/pending` automatically creates a session for that user ID. Set it to your real Slack user ID so the allowlist check passes once you wire up real credentials.

The `team_join` welcome flow requires real Slack credentials and cannot be tested locally without a tunnelling tool (e.g. `ngrok`).

## API

### `POST /api/slack/events`

Receives events from the Slack Events API. Verifies the request signature using `SLACK_SIGNING_SECRET` and returns `401` if invalid.

Handles two event types:

| Event | Action |
|---|---|
| `url_verification` | Returns the Slack challenge token (required when first configuring the URL) |
| `team_join` | Looks up the new member in solidarity.tech, invites them to their county channel(s), and sends a welcome DM |

The `team_join` handler does nothing if the member's email is not found in solidarity.tech, or if their chapter has no entry in `SOLIDARITY_CHAPTER_CHANNEL_MAP`.

### `GET /webhook`

Called by solidarity.tech when a volunteer needs help joining Slack. Stores the volunteer's details and posts to the tracking channel. Returns `401` if the secret is wrong.

| Parameter | Required | Description |
|---|---|---|
| `secret` | Yes | Must match `WEBHOOK_SECRET` |
| `email` | No* | Volunteer's email address |
| `name` | No | Volunteer's full name |
| `phone` | No* | Volunteer's phone number |

\* At least one of `email` or `phone` is required.

If the same email is submitted again, the existing record is updated with the new name, phone, and timestamp.

### `GET /pending`

Protected by Slack OAuth. Redirects unauthenticated users to Sign in with Slack. Only users listed in `SLACK_ALLOWED_USER_IDS` are granted access. Displays a web page listing volunteers who have requested help but still haven't joined the workspace.

The underlying JSON is also available at `GET /api/pending`:

```json
{
  "pending": [
    {
      "id": 1,
      "email": "volunteer@example.com",
      "name": "Jane Smith",
      "phone": "555-1234",
      "comment": null,
      "in_slack": false,
      "status": "uncontacted",
      "lastEditedById": null,
      "lastEditedByName": null
    }
  ],
  "total_requested": 5,
  "total_pending": 4
}
```

- `in_slack` is `true` when the volunteer's email matches an active member in the Slack workspace.
- `status` is one of `uncontacted`, `contacted`, or `verified_in_slack`. Rows with `verified_in_slack` are excluded from `total_pending`.
- `lastEditedByName` / `lastEditedById` record which admin last updated the row.

Admins can add a comment or change a row's status directly on the page. Changes are saved automatically and pushed live to all connected users via Server-Sent Events (`GET /api/events`).

### `POST /api/comment`

Saves a comment for a request. Requires an active Slack OAuth session. Passing a blank string clears the comment.

```json
{ "id": 1, "comment": "Left a voicemail, waiting to hear back." }
```

### `POST /api/helped`

Updates the status of a request. Requires an active Slack OAuth session. `status` must be one of `uncontacted`, `contacted`, or `verified_in_slack`.

```json
{ "id": 1, "status": "verified_in_slack" }
```

### `GET /`, `GET /dashboard/solidarity`, `GET /dashboard/slack`

Signup-trend dashboard. The whole site (and any future route) is gated by a root layout guard that redirects unauthenticated visitors to `/auth/slack`; any workspace member who completes OAuth can view the dashboard (no admin gate). `/pending` keeps its own `SLACK_ALLOWED_USER_IDS` admin check.

- `/` renders two non-interactive overview cards (Solidarity, Slack) showing daily totals.
- `/dashboard/solidarity` and `/dashboard/slack` render stacked-by-chapter bars with the top 10 chapters named and the rest rolled into an "Other" band. The Slack page also overlays a per-day distinct-user total marker (a member who joined multiple chapters in one day is counted in each band but only once in the daily total).
- Range preset (7/30/90 days) lives in `?days=` so reloads and shared links preserve the selection. Invalid or out-of-range values snap to the nearest preset.
- Each card has a visually-hidden `<table>` with the same data so screen readers can read out per-day values.

### `GET /api/dashboard/signups`

The same data the dashboard pages render, as JSON. Requires an active session (no admin gate).

| Parameter | Required | Description |
|---|---|---|
| `days` | No | Window size in days. Defaults to 90; clamped to 1..365. |

```jsonc
{
  "solidarity": [
    {
      "date": "2026-05-09",
      "total": 14,                    // sum of byChapter
      "byChapter": [
        { "chapterId": 123, "chapterName": "Washtenaw County", "count": 9 },
        { "chapterId": null, "chapterName": null, "count": 5 }
      ]
    }
  ],
  "slack": [
    {
      "date": "2026-05-09",
      "total": 11,                    // distinct users that day (not sum of byChapter)
      "byChapter": [
        { "chapterId": 123, "chapterName": "Washtenaw County", "count": 7 },
        { "chapterId": 456, "chapterName": "Wayne County",     "count": 4 }
      ]
    }
  ]
}
```

`chapterId: null` represents the "No chapter" bucket. The Slack `total` is the distinct user count for the day, so it can be less than the sum of `byChapter[*].count` when a member joined more than one chapter.

### `POST /api/internal/weekly-growth-report`

Scheduler-only. Computes the per-chapter growth leaderboard for the previous 7 days and posts the top 5 to `SLACK_GROWTH_REPORT_CHANNEL_ID`. Auth via `?key=<INTERNAL_CRON_SECRET>`.

| Parameter | Required | Description |
|---|---|---|
| `key` | Yes | Must match `INTERNAL_CRON_SECRET` |
| `dry_run` | No | When `1`, returns the result without posting to Slack |

Returns the full leaderboard (window, totals, top chapters, whether the message was posted). The ranking score is `newJoins / (existing + 1) ^ SLACK_GROWTH_REPORT_RANKING_ALPHA`. Chapters listed in `REPORT_EXCLUDED_CHAPTER_IDS` are skipped.

### `POST /api/internal/solidarity-snapshot`

Scheduler-only. Writes today's per-chapter Solidarity signup counts into `solidarity_daily_snapshots`. The dashboard's Solidarity chart reads from this table, so this should run once per day (e.g. via GitHub Actions). Auth via `?key=<INTERNAL_CRON_SECRET>`.

### `GET /coalition-invite`

Invites an existing Slack user to a coalition channel. Useful for solidarity.tech automations that route members to interest-based channels (labor, housing, etc.) after onboarding.

| Parameter | Required | Description |
|---|---|---|
| `secret` | Yes | Must match `WEBHOOK_SECRET` |
| `email` | Yes | Email of an existing Slack workspace member |
| `coalition` | Yes | Key in `COALITION_CHANNEL_MAP` (case-insensitive) |

Returns `{ "success": true }` on a successful invite, `{ "success": true, "already_in_channel": true }` if the user was already in the channel, `404` if no Slack user matches the email, `400` for unknown coalitions or invalid input, and `502` if Slack rejects the invite.

### `GET /api/events`

Server-Sent Events stream. Requires an active Slack OAuth session. Pushes three event types:

| `type` | Payload | Meaning |
|---|---|---|
| `new-request` | `id, email, name, phone` | A new volunteer record was created |
| `status` | `id, status, editedBy` | A row's status changed |
| `comment` | `id, comment, editedBy` | A row's comment changed |

### `GET /auth/slack`

Starts the Slack OAuth login flow. Redirected to automatically when visiting `/pending` without a session.

### `POST /auth/logout`

Destroys the current session.

### `GET /health`

Returns `{ "status": "ok" }`. Useful for uptime monitoring.

## Deployment

[Fly.io](https://fly.io) is the recommended hosting option. Install the CLI, run `fly launch` in the project directory, then set secrets and deploy:

```bash
fly secrets set \
  SLACK_BOT_TOKEN=xoxb-... \
  SLACK_CLIENT_ID=... \
  SLACK_CLIENT_SECRET=... \
  SLACK_SIGNING_SECRET=... \
  SLACK_ALLOWED_USER_IDS=U012AB3CD \
  SLACK_TRACKING_CHANNEL_ID=C012AB3CD \
  SLACK_GROWTH_REPORT_CHANNEL_ID=C012AB3CD \
  REPORT_EXCLUDED_CHAPTER_IDS=1008 \
  TURSO_DATABASE_URL=libsql://your-db.turso.io \
  TURSO_AUTH_TOKEN=... \
  WEBHOOK_SECRET=... \
  INTERNAL_CRON_SECRET=$(openssl rand -hex 32) \
  APP_URL=https://your-app.fly.dev \
  ORIGIN=https://your-app.fly.dev \
  SOLIDARITY_API_TOKEN=... \
  'SOLIDARITY_CHAPTER_CHANNEL_MAP=[{"chapterId":123,"channelId":"C012AB3CD","name":"Washtenaw County"}]' \
  'COALITION_CHANNEL_MAP={"labor":"C0ALZBGF9C2","housing":"C0ALZBGF9C3"}'

fly deploy
```

Then point a scheduler at:
- `POST https://your-app.fly.dev/api/internal/solidarity-snapshot?key=$INTERNAL_CRON_SECRET` — daily
- `POST https://your-app.fly.dev/api/internal/weekly-growth-report?key=$INTERNAL_CRON_SECRET` — weekly

`ORIGIN` is required by SvelteKit's adapter-node for CSRF protection — it must match the public URL of your app. Set it to the same value as `APP_URL`.

Use the resulting URL as:
- The webhook endpoint in solidarity.tech: `https://your-app.fly.dev/webhook?secret=...&email=...&name=...&phone=...`
- The redirect URL in your Slack App: `https://your-app.fly.dev/auth/slack/callback`
- The Events API Request URL in your Slack App: `https://your-app.fly.dev/api/slack/events`