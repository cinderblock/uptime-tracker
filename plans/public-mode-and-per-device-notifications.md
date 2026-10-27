# Public mode, per-device notifications, and secret services

**Plan path:** `plans/public-mode-and-per-device-notifications.md`
**Status:** A, B and D built on branch `public-mode-notifications` and deployed to the SVDSA test deployment; D is live on ops. C built on branch `secret-services` (cut from `public-mode-notifications`), 122 tests passing, not deployed. Next: real-device push check, then C on the test deployment with Helena's address, then E.
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
- **D. Traffic and cost hardening.** A public page mustn't let a stranger exhaust the
  account's daily limits or run up a bill. Added after Cameron asked, 2026-10-26.
- **E. Webhook alerts.** Every event, with metadata, posted to Slack (directly or via
  the chapter's bot on Helena).

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

### C. Secret services (as built, branch `secret-services`)

- **Where they're defined.** A Worker secret `SECRET_SERVICES` holds a plain JSON
  array (not base64: it's pasted into the Cloudflare dashboard or `wrangler secret
put`, never set by CI, so GitLab masking doesn't apply). Entry shape:
  `{id, name, panel?, labels?, address, kind: 'http'|'tcp', port?, host?, path?,
expect?, redirect?, timeout?}`. `host` (the `Host` header) is required for `http`;
  `path`, `expect` and `redirect` are `http`-only. Defaults: port 80 (`http`) or
  443 (`tcp`), path `/`, timeout 10 s, panel "Direct checks". See README "Secret
  services" for the full table.
- **Validation is strict and silent about values.** Unknown fields, bad ids,
  duplicate ids, a non-bare address, CR/LF or spaces in `host`/`path`, port 25, and
  `http`-only fields on `tcp` all reject the whole secret. Errors name the entry
  index and field only. JSON parse errors aren't passed on at all, because V8's
  message quotes the input. A bad secret turns secret services off and leaves the
  rest of the tick alone. It's parsed once per distinct value per isolate
  (`createSecretServiceResolver`).
- **How they join the pipeline.** Each entry becomes an ordinary `ServiceConfig`
  with `host: 'secret:<id>'` and an internal `secret` probe field, added to the
  effective config that `fetch()` and `scheduled()` both resolve first. So status,
  uptime, charts, transitions, bells and per-device notifications all work
  unchanged, keyed `secret:<id>`. `runServiceChecks` sends secret services to
  `src/socket-probe.ts`; `estimateSubrequests` counts each as 1, and
  `attemptWithRetry` applies as for any check.
- **The probe.** `http`: `GET <path> HTTP/1.1` with the `Host` header over a plain
  socket. It reads the status line and headers (capped at 16 KB) and validates like
  the fetch checks (status, or a `Location` substring). `tcp`: `socket.opened`.
  Results carry `type: 'secret'` and `url: 'secret://<id>'`; error text has the
  address and Host scrubbed (`[hidden]`, case-insensitive) before it's stored or
  logged. `connect` is injected through `createWorker({ connect })`. The default
  lazily imports `cloudflare:sockets`, so Bun tests never load it; a wrangler
  dry-run bundle keeps it as an external dynamic import.
- **Charts.** `type IN ('https', 'secret')` in the paid backfill and free raw-chart
  queries, and in `updateChartTiered`, so the direct check is the service's
  primary chart series.
- **UI.** A **DIRECT** pill (server and client render) and no link on the name,
  since the URL is an opaque id. The timeline lane gets no link either.
- **Who sees them: everyone sees the stats; no one sees the address.** Decided by
  Cameron, 2026-10-26: "I want the uptime stats to be public, as long as we can
  keep the real ip/dns hidden". So secret services aren't filtered for public
  viewers; instead nothing anywhere holds the address or Host, admin views
  included.
- **Redaction audit** (`test/secret-services.test.ts`). It runs a real tick and
  real requests, public and admin, with a probe rigged so the origin's reply and
  errors quote distinctive address and Host strings: dashboard, polls, history,
  `/api/errors`, `/errors`, the subscriptions page and API, and notification
  settings. It then checks every response body and header, every D1 table, every
  console line, and every push payload (decrypted with the device key). A mutation
  test (scrubbing removed) makes it fail.

## Decisions already made (don't re-ask)

- Per-device settings are wanted **before** the SVDSA launch enables push
  notifications. Asked 2026-10-26.
- Secret services are wanted. They aren't urgent and come after A and B.
- Build upstream in this repo on a branch, and test on the SVDSA test deployment
  (ops.isozilla.com doesn't run the engine yet). Decided 2026-10-26.
- `MAX_SUBSCRIPTIONS` defaults to 100.
- **Secret services: stats public, address hidden from everyone** (Cameron,
  2026-10-26). The first use is a direct check of Helena, the chapter's origin
  server, bypassing Cloudflare's proxy, kept in the private config so Helena's
  public IP isn't leaked.
- D is wanted here **and on Cameron's ops deployment** ("do it. on my OPS as well",
  2026-10-26). Ops still runs its own copy, so D gets ported there separately.
- Webhooks: send every event type, with metadata so the receiver can filter. Slack is
  the destination, either directly or through the chapter's bot on Helena (Slack
  limits how many bots a workspace can have).

## Open questions

1. **Webhook transport.** Can the Helena bot take an HTTP POST? I recommend a
   generic JSON event with an HMAC signature header sent to the bot, since that
   uses no Slack app slot. Slack's incoming-webhook format would be an option for
   posting direct. Today Web Push is the only alert channel, and Worker
   exceptions only reach Cloudflare's logs.
2. **What does Helena's origin answer on plain HTTP?** It decides the entry:
   a redirect to HTTPS (`redirect: "https://siliconvalleydsa.org/"`) or a 200.
   If its firewall only allows Cloudflare's ranges, check that a Worker socket
   gets through (undocumented; see Findings).

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
- [x] D. Traffic hardening (this branch):
  - `src/read-memo.ts` reuses chart and uptime reads until `lastUpdate` changes;
  - `src/rate-limit.ts` adds an optional `RATE_LIMITER` binding, applied per IP to
    non-admins and failing open;
  - README "Traffic and cost";
  - `test/traffic.test.ts` counts D1 queries at the shim.
- [x] Deployed A, B and D to the SVDSA test deployment (svdsa-uptime `1efa1b1`).
      Workers Free accepts the rate-limit binding. Push stays inactive until
      `VAPID_PRIVATE_KEY` is set (blocked on Cameron's wrangler login).
- [x] D ported to ops (`ops/cloudflare/workers/uptime`) on ops branch
      `uptime-read-memo-rate-limit` (`9b31c12`). Its tests and hooks pass.
      **Merging to master deploys, so it needs a yes.**
- [ ] Deploy the branch to the SVDSA test deployment. Each step needs a yes:
      bump the submodule, set `PUBLIC_DASHBOARD`, set the VAPID keys, and push to deploy.
- [ ] Verify on real devices: subscribe, per-device bells, a real outage alert, the
      subscribe code, and the admin login.
- [ ] Merge the branch to `master`.
- [x] C. Secret services and the endpoint redaction audit (branch
      `secret-services`, `0f7950b`, plus docs). 122 tests, typecheck and
      prettier pass; a wrangler dry-run bundle builds.
- [ ] C on the SVDSA test deployment: point the submodule at `secret-services`,
      put Helena's entry in `SECRET_SERVICES` (Cameron supplies the address
      privately), deploy, and confirm the DIRECT check goes green.

## Findings / gotchas

- With per-device settings, the old global `notification_settings` table is unused.
  Migration `0012` copies it and leaves it in place, so rolling back to the previous
  release still works.
- A device that predates `0012` keeps `default_enabled = 0` ("no row means off").
  New devices get `1`: every service on, with recovery notices. GitHub workflows
  stay opt-in.
- **The rate-limit binding works on Workers Free.** The docs don't say so (neither
  the binding page nor the pricing page mentions plans), but the SVDSA test deploy
  on 2026-10-26 accepted it and returned 429s.
  Its limits count per location and approximately. `period` must be 10 or 60.
- `caches.default` does nothing on `workers.dev`, which is why the memo is in-isolate
  rather than built on the Cache API.
- Transitions are written _after_ the status blob in a tick, so they aren't memoized:
  a view between the two writes would otherwise pin old transitions for a whole tick.
- **Measured on Cloudflare's edge, 2026-10-26** (a throwaway `wrangler dev --remote`
  probe on the test account, against a non-Cloudflare IP):
  - `fetch('https://<ip>/')` returns **403**: Workers can't fetch raw IPs.
  - `connect()` from `cloudflare:sockets` to `<ip>:80`, plain HTTP with a `Host`
    header, works (`HTTP/1.1 301 Moved Permanently`).
  - TLS to an IP fails certificate verification ("IP address mismatch"), with
    `secureTransport: 'on'` and with `'starttls'` plus `startTls({
expectedServerHostname })`, at both compatibility dates tried. So
    **certificate-verified HTTPS by IP is impossible from a Worker**, and secret
    services check plain HTTP or TCP.
- Whether a Worker's outbound sockets come from Cloudflare's published ranges (so
  an origin firewall allowing only those lets the check in) isn't documented.
  Confirm it on Helena.
- The D1 test shims in the older test files share one statement object across
  `bind()` calls, so a `batch()` of binds off one prepared statement writes the
  last row N times. `test/secret-services.test.ts` uses a shim whose `bind`
  returns a new statement; the others still have the bug (harmless for what they
  assert).
- Bash heredocs in this environment choke on large quoted Python bodies. Write the
  edit script to a file, or use small Edit calls.

## Things not to do

- Don't change today's default behaviour. Every new mode is opt-in.
- Don't put push endpoints in query strings or logs. Today's code logs only a
  truncated prefix. Keep it that way.
- Don't key anything that an API exposes by a secret service's host.
