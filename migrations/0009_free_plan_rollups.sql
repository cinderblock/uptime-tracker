-- Free-plan storage: D1 stand-ins for the paid profile's KV blobs.
--
-- The paid profile keeps all rolled-up history in a handful of large KV values
-- (`cache:chart-tiered`, `cache:uptime-buckets`, `cache:hot`,
-- `cache:transitions`), parsed and re-stringified once per cron tick. That is
-- the right trade on paid — one KV read serves a whole dashboard load and D1
-- is never touched on the request path — but it is impossible on free: 1,000
-- KV writes/day and 10 ms CPU per invocation cannot absorb a ~3 MB JSON
-- round-trip every tick.
--
-- So `PLAN=free` (src/plan.ts, `aggregateStore: 'd1'`) routes that state here
-- instead. These tables are UNUSED when PLAN=paid — the migration is safe to
-- apply to a paid database, it just leaves two empty tables behind.
--
-- Two different mechanisms, because the blobs differ by orders of magnitude:
--
--   1. `blobs` — the small JSON values (`cache:hot`, `cache:transitions`) move
--      over verbatim, one row each. They are small enough that a read/write
--      per tick stays well inside the CPU budget.
--
--   2. `uptime_hourly` — the LARGE aggregates (chart + uptime) are not stored
--      as blobs at all; moving megabytes into D1 would blow the same CPU
--      budget from the other direction. Instead this table is upserted
--      incrementally each tick (one row per service per hour) and the chart /
--      uptime figures are computed from it on read. See src/storage-free.ts.
--
-- Read cost, which is what D1 bills on free (rows *scanned*, 5M/day): a full
-- dashboard load scans ~4,200 rows here (25 services x 168 h at the free
-- profile's 7-day retention) plus ~1,800 from `checks` for the last 6 h of
-- fine-grained points. ~6,000 rows/load leaves room for ~800 loads/day.

-- Per-service, per-hour rolled-up check counters. One row per (service, hour);
-- the cron UPSERTs into the current hour's row each tick.
CREATE TABLE uptime_hourly (
  service TEXT NOT NULL,
  hb INTEGER NOT NULL,            -- hour bucket: floor(timestamp / 3600000)
  ups INTEGER NOT NULL DEFAULT 0,     -- checks that came back 'up' this hour
  totals INTEGER NOT NULL DEFAULT 0,  -- checks recorded this hour
  lat_sum INTEGER NOT NULL DEFAULT 0, -- sum of latencies (ms), for an hourly mean
  lat_max INTEGER NOT NULL DEFAULT 0, -- worst latency (ms), plotted as the hour's point
  PRIMARY KEY (service, hb)
);

-- Retention sweeps and the chart/uptime reads are both bounded by hour, and
-- they span every service — so the leading-column of the primary key is the
-- wrong access path for them. Index hb on its own.
CREATE INDEX idx_uptime_hourly_hb ON uptime_hourly(hb);

-- Small singleton JSON documents, keyed by the same `cache:*` names the paid
-- profile uses in KV so both paths speak one vocabulary.
CREATE TABLE blobs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL  -- Unix ms (consistent with checks/ddns_log)
);
