# uptime-tracker

Self-hosted uptime monitoring, status dashboard, and push notifications on
Cloudflare Workers. **Runs on the free plan.**

One worker, one D1 database, one KV namespace. No servers, no containers, no
third-party monitoring service.

## Features

- **Health checks** — HTTP/HTTPS checks with expected status codes, redirect
  assertions, and `www` → apex verification. Budget-aware scheduling checks the
  most important and most stale services first, so a large service list degrades
  gracefully instead of failing.
- **Dashboard** — live status, 7d/30d uptime percentages, latency charts,
  dark/light theme, installable as a PWA.
- **Event timeline** — correlation swimlanes showing only state _changes_ across
  services, CI workflows, and DDNS clients on one shared time axis, so
  coincident events line up vertically.
- **Push notifications** — Web Push (RFC 8291/8292 VAPID), with per-service
  failure thresholds, recovery notices, and urgency levels.
- **GitHub Actions badges** _(optional)_ — workflow run status and build-failure
  alerts.
- **Cost monitor** _(optional)_ — hourly Cloudflare usage polling via the
  GraphQL Analytics API with threshold alerts, so this doesn't quietly cost you
  money.
- **DDNS log** _(optional)_ — tracks IP changes and failures from a dynamic-DNS
  updater.

## Which plan?

This is the unusual part, so it's worth understanding before you deploy.

Cloudflare's free and paid tiers have **inverted** scarcity, and the optimal
design differs accordingly:

|                            | Free ($0/mo)             | Workers Paid ($5/mo)         |
| -------------------------- | ------------------------ | ---------------------------- |
| CPU per invocation         | **10 ms** (not raisable) | 30 s (configurable to 5 min) |
| Subrequests per invocation | **50**                   | 10,000                       |
| KV writes                  | **1,000/day**            | 1M/month                     |
| D1 rows written            | 100,000/day              | 50M/month                    |
| D1 rows read               | 5M/day                   | billed per row _scanned_     |

On **free**, KV is write-starved — at a 1-minute cron you couldn't write a
single KV key per tick (1,440 writes needed, 1,000 allowed) — while D1 has
roughly 100× the write headroom. On **paid**, the opposite holds: KV writes are
cheap and D1 bills for every row a query scans, so precomputed KV blobs are what
keep the dashboard's read path free.

So `PLAN` selects more than a set of numbers — it selects where rolled-up history
lives:

```toml
[vars]
PLAN = "free"                 # or "paid"
CRON_INTERVAL_MINUTES = "5"   # must match [triggers] below

[triggers]
crons = ["*/5 * * * *"]       # paid: "* * * * *"
```

|                   | `PLAN = "free"`      | `PLAN = "paid"`       |
| ----------------- | -------------------- | --------------------- |
| Cron              | every 5 min          | every minute          |
| Checks per tick   | 30 subrequests       | effectively unlimited |
| Aggregates        | D1                   | precomputed KV blobs  |
| KV writes         | on state change only | every tick            |
| History retention | 7 days               | 30 days               |
| Dashboard refresh | 60 s                 | 30 s                  |

"Aggregates in D1" does not mean the KV blobs moved into a table — a megabyte of
JSON is just as unaffordable to parse from D1. On free, the two small blobs
(current status, transition timeline) become rows in `blobs`, and the two large
ones are never built at all: the cron keeps an incremental per-service, per-hour
rollup in `uptime_hourly` and the chart and uptime figures are derived from it on
read, with only the last 6 hours coming from raw `checks` rows. A full dashboard
load scans roughly 6,000 D1 rows. See
[`migrations/0009_free_plan_rollups.sql`](migrations/0009_free_plan_rollups.sql)
and [`src/storage-free.ts`](src/storage-free.ts).

One consequence worth knowing: chart resolution differs. The paid tiers keep
1/10/30/120-minute buckets for the primary HTTPS URL of each service. On free,
anything older than 6 hours comes from the hourly rollup, which has no URL or
type dimension — so an hour in which _any_ of a service's checks failed paints
that hour as down. Uptime percentages are unaffected; they count all results on
both plans.

**Free-plan sizing.** The 10 ms CPU ceiling is the real constraint, and it scales
with how much you monitor. Roughly 15 services / 25 check URLs is comfortable;
past that, either raise the cron interval or move to the paid plan. The worker
never checks more than `CHECK_BUDGET` URLs per tick regardless — it rotates
through your service list, prioritising services with alerts enabled and those
checked longest ago, so nothing starves.

See [`src/plan.ts`](src/plan.ts) for every knob and its reasoning. Individual
values can be overridden with env vars without leaving a profile.

### Switching plans

Change `PLAN`, update `[triggers]` and `CRON_INTERVAL_MINUTES` to match, and
redeploy. Derived state carries over on the first cron tick after the switch —
charts and uptime rebuild from the `checks` table, and the event timeline is
copied between stores. You do not need to migrate anything by hand.

Two things to know before switching:

**Free → paid recovers only what free kept.** Charts and uptime rebuild from raw
check history, and the free profile retains 7 days of it, so that's how far back
the rebuilt 30-day view reaches. It fills forward from there. If you plan to
upgrade and want the history, set `HISTORY_RETENTION_DAYS` higher _while still on
free_ — free D1 allows 500 MB per database, far more than a small deployment
needs, and the 7-day default is about keeping query scans cheap rather than
saving space.

**Paid → free prunes history.** Retention drops 30 days → 7, and the next cleanup
tick deletes everything past the new window. This is not reversible. Set
`HISTORY_RETENTION_DAYS = "30"` alongside `PLAN = "free"` if you want to keep it;
the cost is larger scans per dashboard load, so watch your D1 read budget.

## Quick start

```bash
git clone https://github.com/YOUR-USERNAME/uptime-tracker
cd uptime-tracker
bun install

# 1. Create the resources
wrangler d1 create UPTIME_DB
wrangler kv namespace create KV

# 2. Configure
cp wrangler.toml.example wrangler.toml   # paste the IDs from step 1
cp src/config.example.ts src/config.ts   # list what you want monitored

# 3. Create the schema and deploy
bun run migrate
bun run deploy
```

Both `wrangler.toml` and `src/config.ts` are gitignored — your account IDs and
hostnames stay out of version control.

## Using it from your own project

The quick start deploys _this_ repo. If you'd rather keep your configuration in
your own version-controlled repo — and you should, if you run more than one
deployment — import the worker instead of forking it.

Vendor this repo however you like (git submodule, `git subtree`, or a path
dependency), then in your own project:

```ts
// src/index.ts — your repo, your wrangler.toml, your config in git
import { createWorker } from '../vendor/uptime-tracker/src/index';
import { config, ddnsClients } from './config';

export default createWorker({ config, ddnsClients });
```

Point your `wrangler.toml` at your own entry file (`main = "src/index.ts"`) and
deploy from your repo. Nothing has to be created or copied _inside_ the vendored
tree — which matters, because a parent git repo cannot track files inside a
submodule's working tree, and `src/config.ts` here is gitignored.

That works because `src/index.ts` is the library and imports no configuration.
The only file that reads `./config` is `src/worker.ts`, the standalone entry used
by the quick start above. Keep it that way if you send patches.

Your config module is ordinary TypeScript, so it is typechecked against
`DashboardConfig` and reviewable in a diff. Configuration is deliberately _not_
read from an environment variable: a Workers `[vars]` entry is capped at 5 KB on
both Free and Paid, a non-trivial config exceeds that, and parsing it would burn
CPU on every cold start against the Free plan's 10 ms ceiling. Bundled config
counts against the 3 MB compressed script limit instead.

## Authentication

**By default the dashboard is public.** It exposes your monitored hostnames and
their current health, which is often exactly what a status page should do. To
gate it behind a passphrase:

```bash
wrangler secret put DASHBOARD_PASSWORD   # the passphrase
wrangler secret put AUTH_SECRET          # any long random string
```

Both are required together; setting only the password fails loudly at startup
rather than serving unprotected. The session cookie is an HMAC-signed token with
an expiry covered by the signature — not a hash of the password — so the stored
value alone can't be replayed. Rotating `AUTH_SECRET` logs everyone out.

## Push notifications (optional)

```bash
bunx web-push generate-vapid-keys
```

Put the **public** key in `wrangler.toml` as `VAPID_PUBLIC_KEY`, set
`VAPID_SUBJECT` to a `mailto:` or `https://` URL identifying you, and store the
private key as a secret:

```bash
wrangler secret put VAPID_PRIVATE_KEY
```

Then subscribe from the dashboard. Per-service thresholds, recovery notices, and
urgency are configurable from the bell toggles in the UI.

## Optional integrations

**GitHub Actions badges** — list workflows in `config.githubWorkflows`. Public
repos need no credentials; private repos need `wrangler secret put GITHUB_TOKEN`
(a PAT with `actions:read`).

**Cost monitor** — set `CF_ACCOUNT_ID` in `wrangler.toml` and
`wrangler secret put CF_ANALYTICS_TOKEN` (a Cloudflare API token with
_Account Analytics: Read_). Leave `CF_ACCOUNT_ID` empty to disable it entirely.

**Usage ingest** — apps can `POST /api/usage` to report their own spend (LLM
tokens etc.) so it shows in the cost panel. It's exempt from the dashboard
session cookie, since reporting apps aren't browsers, and carries its own
`Authorization: Bearer $USAGE_TOKEN` instead. Unset, the endpoint returns 503 —
it writes to the database, so it is never left open.

**DDNS log** — the worker reads a `ddns_log` table that something else writes.
Any dynamic-DNS updater that can insert rows into the same D1 database works;
see the schema in [`migrations/0002_ddns_log.sql`](migrations/0002_ddns_log.sql).
List the hostnames you expect to report in `ddnsClients`. Empty by default, in
which case the panel stays hidden and no DDNS alerting runs.

## Bindings

| Type | Binding | Purpose                                                                          |
| ---- | ------- | -------------------------------------------------------------------------------- |
| D1   | `DB`    | Check results, DDNS log, push subscriptions, notification history                |
| KV   | `KV`    | Hot-path dashboard status; on paid, also the precomputed chart/uptime aggregates |

## Source layout

| File                | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `worker.ts`         | Standalone entry — the only file that imports `config.ts`        |
| `index.ts`          | The library: `createWorker()`, request + cron handlers, routing  |
| `plan.ts`           | Free/paid plan profiles — every tunable and why                  |
| `config.example.ts` | What to monitor (copy to `config.ts`)                            |
| `types.ts`          | Shared interfaces                                                |
| `checks.ts`         | Check execution, concurrency pool, subrequest budgeting          |
| `storage.ts`        | D1 + KV access, history, uptime math                             |
| `ui.ts`             | Dashboard HTML                                                   |
| `auth.ts`           | Signed-cookie session auth                                       |
| `push.ts`           | Web Push (RFC 8291 encryption + RFC 8292 VAPID), no dependencies |
| `icons.ts`          | PWA icons                                                        |
| `cost/`             | Cloudflare usage polling, pricing, thresholds                    |

## Development

```bash
bun run dev        # wrangler dev against your real remote bindings
bun run test       # unit tests (bun test)
bun run typecheck
```

The tests cover the parts where a mistake is silent rather than loud: session
token signing and expiry, the plan profiles and their env overrides, and the
shipped migration SQL run against real SQLite — including that the errors query
uses its index, and that the paid → free rollup backfill respects retention and
is idempotent. `bun run test` seeds `src/config.ts` from the example first if
you don't have one yet.

`bun run dev` resolves the D1/KV names in `wrangler.toml` to real IDs via the
wrangler CLI, so you can keep names rather than IDs in config. Run
`wrangler login` once first.

## License

MIT — see [LICENSE](LICENSE).
