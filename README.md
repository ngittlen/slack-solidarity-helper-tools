# slack-solidarity-helper-tools

A Slack bot and webhook server for solidarity.tech organisations. It does two things:

- **Welcome new members** — when someone joins the Slack workspace, the bot looks up their solidarity.tech account, automatically adds them to their county chapter channel(s), and sends them a DM with a link to those channels.
- **Help volunteers join Slack** — when a volunteer has trouble joining, solidarity.tech calls the webhook, their details are queued in a database, and admins work through the queue at `/pending` with live updates via Server-Sent Events.

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
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token-here
WEBHOOK_SECRET=your-webhook-secret-here
APP_URL=https://your-app.fly.dev
SOLIDARITY_API_TOKEN=your-solidarity-api-token-here
SOLIDARITY_CHAPTER_CHANNEL_MAP='[{"chapterId":123,"channelId":"C012AB3CD","name":"Washtenaw County"}]'
COALITION_CHANNEL_MAP='{"labor":"C0ALZBGF9C2","housing":"C0ALZBGF9C3"}'
PORT=3000  # defaults to 3000 in production; ignored in dev (Vite uses 5173)
```

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
  TURSO_DATABASE_URL=libsql://your-db.turso.io \
  TURSO_AUTH_TOKEN=... \
  WEBHOOK_SECRET=... \
  APP_URL=https://your-app.fly.dev \
  ORIGIN=https://your-app.fly.dev \
  SOLIDARITY_API_TOKEN=... \
  'SOLIDARITY_CHAPTER_CHANNEL_MAP=[{"chapterId":123,"channelId":"C012AB3CD","name":"Washtenaw County"}]' \
  'COALITION_CHANNEL_MAP={"labor":"C0ALZBGF9C2","housing":"C0ALZBGF9C3"}'

fly deploy
```

`ORIGIN` is required by SvelteKit's adapter-node for CSRF protection — it must match the public URL of your app. Set it to the same value as `APP_URL`.

Use the resulting URL as:
- The webhook endpoint in solidarity.tech: `https://your-app.fly.dev/webhook?secret=...&email=...&name=...&phone=...`
- The redirect URL in your Slack App: `https://your-app.fly.dev/auth/slack/callback`
- The Events API Request URL in your Slack App: `https://your-app.fly.dev/api/slack/events`