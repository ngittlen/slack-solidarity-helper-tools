# Security Policy

## Reporting a vulnerability

**Report privately, through GitHub.** Go to the repository's
[**Security** tab → **Report a vulnerability**](https://github.com/tools4abdul/slack-solidarity-helper-tools/security/advisories/new).
That opens a private advisory visible only to the maintainers.

Please **do not** open a public issue, a pull request, or a Slack message for anything that
would let someone else exploit the flaw before it is fixed.

Useful things to include, roughly in order of value:

1. What an attacker gets — read a volunteer's phone number, post as another member, claim turf
   someone else holds, reach an admin-only page without being an admin.
2. The route or file involved, and the request that triggers it.
3. Whether it needs a Slack session, a Google or Apple sign-in (which anyone can get), a workspace
   membership, an admin role, or nothing at all. "Unauthenticated" and "needs an admin account"
   are very different findings.
4. Anything you had to guess about the deployment.

### What to expect

This project is maintained by volunteers, not a security team. Expect:

- **Acknowledgement within about 3 days**, including "still looking at it".
- **An assessment within about 14 days** — whether it is accepted, what the severity looks like,
  and a rough fix timeline.
- **Credit in the advisory**, unless you would rather not be named.

There is no bug bounty and no payment. If a report is declined you will be told why, not ignored.

### Safe harbor

Testing done in good faith against your own deployment or a local instance is welcome and will
not be met with a complaint. Please do not test against `slack.tools4abdul.com` in ways that
touch other people's data, degrade the service, or spam a real Slack workspace — a local
instance (`npm run dev` with `TURSO_DATABASE_URL=file:local.db`) plus `npm run db:seed` gives
you the whole app with synthetic data. If you believe a finding can only be demonstrated
against production, say so in the report first.

## Supported versions

Only the current `main` branch is supported, and only the deployment running from it. There are
no maintained release branches and no backports — fixes land on `main` and deploy from there.

Dependencies are pinned in `package-lock.json`; the Node version in the `Dockerfile` and in
`.github/workflows/ci.yml` are kept identical so CI runs what deploys.

## Scope

**In scope** — this repository's code and the app it builds:

- Authentication and session handling, for Slack, Google and Apple sign-in
- Anything a Google or Apple sign-in can reach beyond turf checkout
- The admin allowlist and any way around it
- Slack request-signature verification and the webhook / cron secrets
- The turf checkout rules (claiming turf you do not hold, exceeding limits, reading another
  volunteer's MiniVAN list number)
- Data exposure: any route serving a member's contact details, a moderation note, or a roster to
  someone who should not see it
- Injection, SSRF, XSS, CSRF, and dependency vulnerabilities that are actually reachable here

**Out of scope** — report these to the vendor, not here:

- Slack, Google, solidarity.tech, EveryAction/VAN, Mobilize, Fly.io, Turso, CARTO
- Anything requiring a workspace admin to be already compromised, or physical access
- Missing hardening headers with no demonstrated impact, and automated-scanner output without
  a working path to harm
- Social engineering of the volunteer team

A misconfiguration in one operator's own deployment (a public member notes channel, a leaked
`WEBHOOK_SECRET`) is theirs to fix — but if the code makes that mistake easy to make, that is a
finding worth reporting.

## How the app is protected

Context for anyone assessing it. All of this is in the repository; none of it is a claim that
the app is unbreakable.

### Authentication and authorization

- **Sign-in is Slack OAuth, or Google or Apple for turf checkout only.** The site is behind a root layout
  guard that redirects unauthenticated visitors to `/signin`. Only the policy pages, the sign-in
  page and the `/turfs` teaser are public. There is no password to leak or guess.
- **Session cookies** carry a random ID only, and are `httpOnly`, `sameSite=lax`, and `secure`
  outside dev. Sessions live server-side, expire after 8 hours, and are deleted on expiry.
- **The OAuth `state` is signed and time-limited**, and its nonce is bound to a cookie
  (`src/lib/server/oauth-state.ts`). The state names which flow it belongs to, and each callback
  refuses the others'. Google sign-in also uses PKCE, asks only for `openid email profile`, and
  keeps no Google token.
- **Apple sign-in returns by a cross-site form post**, because Apple requires that when asking
  for name and email. So its callback, `POST /auth/apple/callback` and nothing else, is exempt
  from the cross-site form check (`src/lib/server/csrf.ts`), and its flow cookies are
  `SameSite=None; Secure` so they survive the post. What authenticates it instead: the signed
  state's nonce must match one cookie, the id token's `nonce` must match a second, and the code
  becomes a session only after Apple accepts it with a client secret signed by our key. The
  id token Apple also posts in the form is ignored. It asks only for name and email and keeps no
  Apple token.
- **Four tiers.**
  - Anyone with a Google account or an Apple ID can sign in, but such a session reaches turf
    checkout and nothing else. That is enforced for every request in `src/hooks.server.ts` by a
    deny-by-default allow-list of routes (`src/lib/server/turf-only-access.ts`), one list for
    both providers, and a test walks every route to keep it that way. A Google or Apple session is
    never an admin or moderator.
  - Any Slack workspace member may see the dashboards and the turf page.
  - Moderators (`slack_moderators`) can also use member lookup and the info commands.
  - Everything else is gated on a database-backed admin allowlist (`allowed_slack_users`, edited
    on `/settings`), with `SLACK_SUPERUSER_ID` as a break-glass entry. The allowlist has no
    environment fallback, and the last admin cannot be removed. Anyone else gets a bare redirect.
- **`DEV_SLACK_USER_ID` bypasses OAuth and is a development-only affordance.** It must never be
  set in production, and the app refuses to start if it is.

### Request authenticity

- **Slack requests are signature-verified** over the raw body against `SLACK_SIGNING_SECRET`
  before anything is parsed (`src/lib/server/slack-signature.ts`).
- **CSRF is re-implemented in `src/hooks.server.ts`.** SvelteKit's built-in check is disabled in
  `svelte.config.js` because Slack posts form-encoded payloads with no `Origin` header; the
  replacement exempts only the signature-verified `/api/slack/*` routes. `src/lib/server/csrf.ts`
  has the reasoning. **Any change here deserves close review** — it is the one place the
  framework's default protection was deliberately turned off.
- **`/webhook` and `/coalition-invite`** are gated on `WEBHOOK_SECRET`, and `/api/internal/*` on
  `INTERNAL_CRON_SECRET`. Both are bearer secrets in a query string, so they appear in logs at
  every hop — treat them as rotatable, and rotate on any suspicion.

### Secrets and data at rest

- **Slack user tokens are encrypted with AES-256-GCM** before they are written
  (`src/lib/server/token-crypto.ts`), with a fresh random IV per record and the key held in
  `TOKEN_ENCRYPTION_KEY` outside the database. Only admins and moderators who turn on "post as
  you" have one. A database dump yields ciphertext, not working credentials. The app refuses to
  start if the key is missing or does not decode to 32 bytes. Rotating the key invalidates every
  stored token; their owners simply turn "post as you" on again.
- **All other secrets live in Fly secrets**, never in the repository or the database.
  `.env.local` is gitignored.
- **Nothing sensitive is committed.** The seed data (`npm run db:seed`) is fully synthetic.
  `npm run db:replica` does copy production into a local file for testing. It leaves out sessions,
  Slack tokens, and the sign-in records and turf messages of Google and Apple volunteers, and
  replaces those volunteers' account IDs and names with stand-ins (`scripts/replica-scrub.ts`).
  Everything else is copied, moderation notes and Slack members' contact details included, so a
  replica is production data and should be handled as such.

### Data minimization, by design

These are structural properties, and they exist because losing them would be a security
regression even though nothing would visibly break:

- **The MiniVAN list number is the credential** that pulls voter records down to a phone. It is
  given only to the volunteer currently holding the turf: in an ephemeral Slack message, or on
  their own turf card on `/turfs`. For a Google or Apple holder, a changed number is kept with their
  turf messages for at most a week. It is withheld from the organizer and activity pages — from admins
  too — and kept out of Slack notification fallback text, the one thing that renders on a locked
  phone.
- **Chapter filtering happens server-side before serializing.** The payload is the boundary;
  filtering in the browser would make the compartment cosmetic.
- **The Solidarity roster is searched server-side and never sent to the browser.**
- **Typed addresses are never stored or logged**, and coordinates in button values are rounded
  to ~100 m.
- **A Google or Apple volunteer's email is shown to admins only** — an Apple Hide My Email relay
  address marked as one. It is added to admin views on the server and never logged or posted to
  Slack. Display names — from a Google profile, Apple's first sign-in, or typed on `/turfs` — are
  cleaned before they are stored and escaped wherever they are posted to Slack, so a chosen name
  cannot ping a channel or post a link, and are written to sheets so they cannot run as a formula.

### Abuse limits

- **Per-user rate limits** on turf browsing (12 chapters/hour, counting only chapters whose VAN
  folders the user has not already seen through another chapter) and the turf API (60
  requests/minute), shared between the page and the API in
  `src/lib/server/van/rate-limit-store.ts`. They follow the user, not the URL — an earlier
  module-scoped limiter was bypassed simply by using the API instead of the page. They apply to
  Google and Apple sign-ins the same way, per account. Because those accounts are free to create,
  they slow down one account rather than a determined person. That gap is known and recorded for
  follow-up.
- **The signed-out `/turfs` teaser** allows 10 lookups a minute per visitor address.
- **Turf claim races are resolved in storage**, by a partial unique index on
  `van_turf_checkouts (turf_id) WHERE released_at IS NULL AND completed_at IS NULL`, not in
  application code.
- **Release and complete are scoped to the caller's own active claim**, so posting someone
  else's route ID does nothing.

### Build and deploy

- CI runs Prettier, ESLint, `svelte-check`, and the full test suite on every push and pull
  request; **deploys are gated on all of them** and only run from `main`.
- Migrations run as Fly's `release_command`, before new machines take traffic, so a failing
  migration aborts the release rather than half-applying.
- The container runs as the unprivileged `node` user.

## For operators

If you deploy this yourself, the checklist:

1. **Generate every secret freshly.** `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`),
   `INTERNAL_CRON_SECRET` and `WEBHOOK_SECRET` (`openssl rand -hex 32`). Never reuse another
   deployment's.
2. **Never set `DEV_SLACK_USER_ID` or `DEV_VIEW_AS` in production.** The app refuses to start if
   either is set.
3. **Set `ORIGIN` to your real public URL.** It is what the CSRF check compares against.
4. **Make the member notes channel private.** Note text and warning text both land there.
5. **Keep the admin allowlist short**, and remove people when they stop organizing. An admin who
   turned on "post as you" has a Slack user token stored (encrypted) that can post as them.
6. **Rotate `WEBHOOK_SECRET` and `INTERNAL_CRON_SECRET` periodically**, since they travel in URLs.
7. **Restrict database access.** The Turso token reads everything, including moderation records
   and contact details.
8. **Use a keyed map tile account** before real volunteer traffic; the default CARTO endpoint is
   courtesy, not an SLA.
9. **Give VAN and canvassing integrations their own service accounts** with the least access
   that works — missing tiers degrade rather than fail.
10. **If you enable Google sign-in,** register the redirect URI exactly
    (`<APP_URL>/auth/google/callback`), keep `GOOGLE_OAUTH_CLIENT_SECRET` in Fly secrets, and
    point the consent screen's terms and privacy links at `/terms` and `/privacy`. Remember that
    anyone with a Google account can then open turf checkout.
11. **If you enable Apple sign-in,** register the domain and `<APP_URL>/auth/apple/callback` on
    the Services ID, keep the `.p8` key in Fly secrets (`APPLE_SIGNIN_PRIVATE_KEY`) and nowhere
    in the repository, and revoke and replace it if it ever leaks. Anyone with an Apple ID can
    then open turf checkout.

See [PRIVACY.md](PRIVACY.md) for what the app collects and how long it keeps it, and
[TERMS.md](TERMS.md) for the terms of use.
