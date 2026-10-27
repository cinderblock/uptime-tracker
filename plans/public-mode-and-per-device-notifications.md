# Public mode, per-device notifications, and secret services

**Plan path:** `plans/public-mode-and-per-device-notifications.md`
**Status:** A and B built on branch `public-mode-notifications` (`11cfbb7`, `21c0803`), 99 tests passing. Next: test on the SVDSA test deployment (needs per-change yeses), then C.
**Related:** `~/git/svdsa/stack/plans/uptime-to-chapter-account.md` covers the SVDSA
deployment that motivates this work.

## Goal

Make a public status page that people can subscribe to safely:

- **A. Access tiers.** Anyone can read the dashboard. Only a logged-in admin can use
  the admin parts (subscriber list, deletion, and anything hidden).
- **B. Per-device notification settings.** Each subscribed device chooses its own
  services, thresholds, recovery notices and urgency.
- **C. Secret services.** Hosts that are monitored but never published in the repo
  or shown to public viewers (for example, an origin server hidden behind the
  Cloudflare proxy).

A is a prerequisite for both B and C. Build in that order.

## Environment / context

- This repo is the engine. Two deployments consume it as a library:
  - Cameron's private ops deployment: paid plan, password-gated, push on;
  - `svdsa-uptime`: free plan, public, push off. It will become `svdsa/uptime-config`
    on GitLab.
- **`ops.isozilla.com` does NOT run this engine yet** (checked 2026-10-26). It still runs its own
  copy at `ops/cloudflare/workers/uptime`, which has grown ops-only features: deploy-drift,
  deploy hooks, down-credibility, host-alerts. Moving ops onto the engine is step 9 of
  `ops/plans/uptime-tracker-extraction.md` and is still open. The only live consumer of this
  engine is the SVDSA test deployment (free plan, currently passphrase-gated, push off).
- **Every change must leave existing deployments behaving exactly as they do today.**
  New behaviour is opt-in, and migrations carry existing settings over.

## How it works today (checked 2026-10-26)

- Auth is all-or-nothing (`src/auth.ts`). If `DASHBOARD_PASSWORD` is set, everything
  outside `PUBLIC_PATHS` needs the cookie. If it's unset, everything is open,
  including `GET/DELETE /api/subscriptions` and `POST /api/notification-settings`.
- `notification_settings` is keyed by service key (host, `ddns`, `gh:…`) with **no
  subscriber column**, so settings are global.
- `sendNotifications()` sends the same payload to every row in `push_subscriptions`.
- `notification_state.consecutive_down` holds the per-service failure count. For
  DDNS ip-change and GitHub workflows it is reused to store a cursor or run ID.

## Design

### A. Access tiers

- New var `PUBLIC_DASHBOARD = "true"`. Unset means today's behaviour.
- With `PUBLIC_DASHBOARD` on:
  - read endpoints and pages are open;
  - subscribing and a device managing **its own** settings are open (see B);
  - admin endpoints need the login cookie: `/subscriptions`, `/api/subscriptions`,
    and any view that includes secret services. With no password set, admin
    endpoints return 404 rather than falling open.
- **How admins log in.** Use the mechanism that already exists: one shared
  passphrase (`DASHBOARD_PASSWORD`) entered at `/login`, which sets an HMAC-signed
  cookie lasting a year. Rotating `AUTH_SECRET` logs every admin out. There are no
  per-person accounts.
  - Public mode adds a small "Admin" link, because today the login page only
    appears when the whole dashboard is gated.
  - Public mode also adds **login throttling.** `/login` has no attempt limit today,
    which is fine behind obscurity but not on a public status page.
  - **Possible later upgrade: Cloudflare Access** in front of `/login` and the admin
    paths. That gives per-person login (email code or Google), revocable one person
    at a time, and free for up to 50 users. It needs the tech chair to set up Zero
    Trust, and the Worker to verify the `Cf-Access-Jwt-Assertion` header. It can be
    supported alongside the passphrase.

### B. Per-device settings

- **Identity.** A device is identified by its push subscription endpoint. That URL
  is unguessable, and the browser can always get it back with
  `pushManager.getSubscription()`. It only ever travels in a POST body, never in a
  query string, so it stays out of logs.
- **Schema (new migration).**
  - `subscription_settings (subscription_id, key, enabled, failure_threshold,
notify_recovery, urgency, updated_at)`, with primary key
    `(subscription_id, key)`. It cascades on subscription delete.
  - `subscription_state (subscription_id, key, notified_down)`: per-device "already
    told you about this outage".
  - `notification_state` keeps the per-service `consecutive_down` and the cursors,
    which are properties of the service rather than the subscriber.
  - **Carry-over:** the migration copies every existing `notification_settings` row
    to every existing subscription, so the ops deployment's devices keep exactly
    what they had. Afterwards `notification_settings` becomes the **default** given
    to newly subscribed devices.
- **API.**
  - `POST /api/my-notification-settings {endpoint}` returns this device's settings.
  - `POST /api/notification-settings {endpoint, key, …}` sets one of them.
  - Requests without a known endpoint get 404.
- **Dispatch.** Each tick computes the per-service events once. For each subscriber
  it then collects the events that subscriber enabled where `consecutive_down ≥`
  their threshold and they haven't been told yet. Each subscriber gets **one**
  combined push, and is marked notified only once delivery succeeds.
- **Subrequest budget.** One push is one subrequest, and the free plan allows 50
  per invocation, with checks already using some. Pushes are capped at the
  remaining budget, and anyone left over is served on the next tick. Per-device
  state makes that carry-over natural.
- **Who may subscribe.** Optional `SUBSCRIBE_PASSWORD`, a shared code separate
  from the admin passphrase:
  - set: the subscribe flow asks for the code once, and a device that's subscribed
    then manages its own settings without the code;
  - unset: anyone can subscribe;
  - a logged-in admin never needs the code;
  - rotating the code doesn't drop existing subscribers. Admins prune them on
    `/subscriptions`.
  - **Recommended for SVDSA:** set it, and share it with the people who should get
    alerts.
- **Backstop.** `MAX_SUBSCRIPTIONS` (default 100). Reject new subscriptions past it.
- **UI.** Bells show this device's settings. Clicking a bell on a device that
  isn't subscribed offers to subscribe first.

### C. Secret services

- **Where they're defined.** A Worker secret `SECRET_SERVICES` holds base64 JSON
  using the same shape as `config.ts` services, plus a panel name. It is merged in
  at runtime. Base64 is there because GitLab can't mask raw JSON, and CI is what
  sets the secret.
- **Keys.** Opaque keys (`secret:<id>`) rather than hosts, so the
  notification-settings keys, D1 rows exposed through APIs, and the timeline never
  carry the host.
- **Who sees them.** Admins only: hidden entirely from public viewers, and only
  subscribable by a logged-in device. Push bodies use the display name, never the
  host.
- **The main cost is an audit.** Every API that returns check data (`/api/errors`,
  history, timeline, status JSON) must filter or redact secret services for public
  viewers, **including error text**, which can contain the hostname or IP. Tests are
  needed for each endpoint.

## Decisions already made (don't re-ask)

- Per-device settings are wanted **before** the SVDSA launch enables push
  notifications. Asked 2026-10-26.
- Secret services are wanted. They aren't urgent and come after A and B.
- Build upstream in this repo on a branch, and test on the SVDSA test deployment
  (ops.isozilla.com doesn't run the engine yet). Decided 2026-10-26.
- `MAX_SUBSCRIPTIONS` defaults to 100.

## Open questions

1. **Webhook alerts (asked 2026-10-26, not designed or built).** The engine has no
   webhook output of any kind; Web Push is the only alert channel. Worker
   exceptions only reach Cloudflare's logs. Proposed: an `ALERT_WEBHOOK_URL`
   secret (Discord/Slack-compatible JSON), per-event-type toggles including
   check errors and Worker exceptions, sharing the per-tick push budget.
   Needs: the destination, and which events.
2. **Who should see secret services?** I recommend admins only. The alternative is
   showing a redacted placeholder ("Private service: up") to the public.


## Progress log

- [x] A. Access tiers (`11cfbb7`). Public allowlist, admin login link, `/logout`, login
      throttling in D1 (migration `0011`), and no stack traces for non-admins. 28 tests
      cover it through the real worker handler.
- [x] B. Per-device settings (`21c0803`):
  - migration `0012`;
  - the pure planner in `src/subscribers.ts`;
  - the device API, keyed by endpoint in POST bodies;
  - `SUBSCRIBE_PASSWORD` and `MAX_SUBSCRIPTIONS`;
  - admin-only DDNS and cost alerts;
  - a per-tick `pushBudget`.

  End-to-end tests run the real `scheduled()` with real Web Push encryption and a
  stubbed network: budget deferral, retry after a failed delivery, and removal of
  expired subscriptions.

- [x] README updated for both.
- [ ] Deploy the branch to the SVDSA test deployment. Each step needs a yes:
      bump the submodule, set `PUBLIC_DASHBOARD`, set the VAPID keys, and push to deploy.
- [ ] Verify on real devices: subscribe, per-device bells, a real outage alert, the
      subscribe code, and the admin login.
- [ ] Merge the branch to `master`.
- [ ] C. Secret services and the endpoint redaction audit, with tests.

## Findings / gotchas

- With per-device settings, the old global `notification_settings` table is unused.
  Migration `0012` copies it and leaves it in place, so rolling back to the previous
  release still works.
- A device that predates `0012` keeps `default_enabled = 0` ("no row means off").
  New devices get `1`: every service on, with recovery notices. GitHub workflows
  stay opt-in.
- Bash heredocs in this environment choke on large quoted Python bodies. Write the
  edit script to a file, or use small Edit calls.

## Things not to do

- Don't change today's default behaviour. Every new mode is opt-in.
- Don't put push endpoints in query strings or logs. Today's code logs only a
  truncated prefix. Keep it that way.
- Don't key anything that an API exposes by a secret service's host.
