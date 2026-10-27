/**
 * Free-profile storage: D1 in place of the paid profile's KV blobs.
 *
 * `PLAN=free` (see plan.ts) cannot use the paid read path. That path keeps all
 * rolled-up history in a few large KV values and re-serialises them every cron
 * tick — fine under 1M KV writes/month and an unbounded CPU limit, impossible
 * under 1,000 KV writes/day and 10 ms CPU per invocation.
 *
 * Two mechanisms, matching migration 0009:
 *
 *   Small blobs (`cache:hot`, `cache:transitions`) → the `blobs` table,
 *   one JSON row each. Same shape as the KV values, same keys.
 *
 *   Large aggregates (chart + uptime) → NOT stored as blobs. `uptime_hourly`
 *   is upserted incrementally each tick (one row per service per hour) and the
 *   chart / uptime numbers are derived from it at read time.
 *
 * Read budget: D1 bills rows *scanned* and free allows 5M/day. A dashboard
 * load scans ~4,200 rows of `uptime_hourly` (25 services x 168 h at 7-day
 * retention) plus ~1,800 rows of `checks` for the last 6 h of fine-grained
 * points — about 6,000 rows, so ~800 loads/day. Nothing here may scan the full
 * `checks` table; every query below is bounded by a timestamp/hour cutoff.
 */

import type { CheckResult } from './types';
import type { ChartData, ChartDataPoint, UptimeByPeriod } from './storage';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** How much of the tail is served from raw `checks` rows rather than the
 *  hourly rollup. Matches the paid profile's finest chart tier (1-minute
 *  points for the last 6 h) so both plans render the same recent detail. */
const RAW_WINDOW_MS = 6 * HOUR_MS;

function hourBucket(tsMs: number): number {
  return Math.floor(tsMs / HOUR_MS);
}

// ── Small JSON blobs ─────────────────────────────────────────────────────────

/** Read a `cache:*` document. Returns null when absent, mirroring `kv.get`. */
export async function blobGet(db: D1Database | undefined, key: string): Promise<string | null> {
  if (!db) return null;
  const row = await db.prepare(`SELECT value FROM blobs WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/** Write a `cache:*` document, mirroring `kv.put`. */
export async function blobPut(db: D1Database | undefined, key: string, value: string): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO blobs (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, Date.now())
    .run();
}

// ── Hourly rollup ────────────────────────────────────────────────────────────

/** Fold fresh check results into the per-service hourly counters.
 *
 *  Results are aggregated in JS first so each (service, hour) pair costs
 *  exactly one statement — a tick with 60 results across 25 services is 25
 *  rows written, not 60, and stays far inside the 50-query-per-invocation
 *  ceiling. */
/**
 * Rebuild `uptime_hourly` from `checks`, for switching PLAN=paid → free.
 *
 * The paid profile keeps its rollups in KV and never populates this table, so
 * without this the dashboard would show no uptime figures and no chart history
 * beyond the last 6 h, silently refilling over the following days — even though
 * `checks` already holds the raw data.
 *
 * One-shot: `rollUpHourly` calls this only when the table is empty. Scans one
 * retention window of `checks`, which is why it must never run per tick.
 */
export async function backfillRollup(db: D1Database, retentionDays: number): Promise<number> {
  const since = Date.now() - retentionDays * DAY_MS;
  const rows = await db
    .prepare(
      `INSERT INTO uptime_hourly (service, hb, ups, totals, lat_sum, lat_max)
       SELECT service,
              CAST(timestamp / ${HOUR_MS} AS INTEGER) AS hb,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END),
              COUNT(*),
              SUM(latency),
              MAX(latency)
       FROM checks
       WHERE timestamp > ?
       GROUP BY service, hb
       ON CONFLICT(service, hb) DO NOTHING`,
    )
    .bind(since)
    .run();
  return rows.meta.changes ?? 0;
}

export async function rollUpHourly(
  db: D1Database | undefined,
  freshResults: CheckResult[],
  retentionDays: number,
): Promise<void> {
  if (!db || freshResults.length === 0) return;

  // Empty table means either a fresh install (nothing to backfill, the scan
  // finds no rows) or a switch from PLAN=paid, where the rollups lived in KV.
  const seeded = await db.prepare(`SELECT 1 FROM uptime_hourly LIMIT 1`).first();
  if (!seeded) {
    const filled = await backfillRollup(db, retentionDays);
    if (filled > 0) console.log(`Backfilled ${filled} uptime_hourly rows from checks (one-time)`);
  }

  interface Accumulator {
    service: string;
    hb: number;
    ups: number;
    totals: number;
    latSum: number;
    latMax: number;
  }
  const acc = new Map<string, Accumulator>();

  for (const r of freshResults) {
    const hb = hourBucket(r.timestamp);
    const mapKey = `${hb}\u0000${r.service}`;
    let a = acc.get(mapKey);
    if (!a) {
      a = { service: r.service, hb, ups: 0, totals: 0, latSum: 0, latMax: 0 };
      acc.set(mapKey, a);
    }
    a.totals++;
    if (r.status === 'up') a.ups++;
    a.latSum += r.latency;
    if (r.latency > a.latMax) a.latMax = r.latency;
  }

  const stmt = db.prepare(
    `INSERT INTO uptime_hourly (service, hb, ups, totals, lat_sum, lat_max)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(service, hb) DO UPDATE SET
       ups = uptime_hourly.ups + excluded.ups,
       totals = uptime_hourly.totals + excluded.totals,
       lat_sum = uptime_hourly.lat_sum + excluded.lat_sum,
       lat_max = max(uptime_hourly.lat_max, excluded.lat_max)`,
  );

  await db.batch([...acc.values()].map(a => stmt.bind(a.service, a.hb, a.ups, a.totals, a.latSum, a.latMax)));
}

/** Uptime percentages and check counts per service, computed from the hourly
 *  rollup in a single grouped query.
 *
 *  Same shape as the paid path's `getMultiPeriodUptime`. The 30-day window is
 *  clamped to `retentionDays`: the free profile only keeps 7 days, and
 *  reporting a "30d" figure over a 7-day window is the honest best available —
 *  `checkCount30d` makes the shorter sample obvious. */
export async function getUptimeFromRollup(
  db: D1Database | undefined,
  retentionDays: number,
): Promise<Record<string, UptimeByPeriod>> {
  if (!db) return {};

  const nowHb = hourBucket(Date.now());
  const cutoff24h = nowHb - 24;
  const cutoff7d = nowHb - 7 * 24;
  // The outer WHERE is what actually bounds the scan, so clamp it to what the
  // table can hold — asking for 30 days of a 7-day table just wastes the range.
  const cutoff30d = nowHb - Math.min(30, retentionDays) * 24;

  const result = await db
    .prepare(
      `SELECT service,
              SUM(CASE WHEN hb >= ?1 THEN ups    ELSE 0 END) AS ups24h,
              SUM(CASE WHEN hb >= ?1 THEN totals ELSE 0 END) AS total24h,
              SUM(CASE WHEN hb >= ?2 THEN ups    ELSE 0 END) AS ups7d,
              SUM(CASE WHEN hb >= ?2 THEN totals ELSE 0 END) AS total7d,
              SUM(ups)    AS ups30d,
              SUM(totals) AS total30d
       FROM uptime_hourly
       WHERE hb >= ?3
       GROUP BY service`,
    )
    .bind(cutoff24h, cutoff7d, cutoff30d)
    .all<{
      service: string;
      ups24h: number;
      total24h: number;
      ups7d: number;
      total7d: number;
      ups30d: number;
      total30d: number;
    }>();

  const stats: Record<string, UptimeByPeriod> = {};
  for (const r of result.results) {
    stats[r.service] = {
      uptime24h: r.total24h > 0 ? (r.ups24h / r.total24h) * 100 : null,
      uptime7d: r.total7d > 0 ? (r.ups7d / r.total7d) * 100 : null,
      uptime30d: r.total30d > 0 ? (r.ups30d / r.total30d) * 100 : null,
      checkCount24h: r.total24h,
      checkCount7d: r.total7d,
      checkCount30d: r.total30d,
    };
  }
  return stats;
}

/** Chart series per service, assembled from two bounded queries:
 *
 *    older than 6 h → one point per hour from `uptime_hourly`
 *    last 6 h       → 1-minute decimated points from `checks`
 *
 *  The rollup has no per-URL detail, so its points carry `lat_max` as the
 *  latency (worst-of-hour, the same "outages must stay visible" bias the paid
 *  profile's worst-of-bucket merge uses) and are marked up only when every
 *  check in the hour passed.
 *
 *  Points come back sorted ascending by ts per service: rollup points first,
 *  then the raw tail. The hour that straddles the 6 h boundary is included
 *  from the rollup — its timestamp (the hour's start) still sorts before every
 *  raw point, and dropping it would leave a visible gap of up to an hour. */
export async function getChartFromRollup(db: D1Database | undefined, retentionDays: number): Promise<ChartData> {
  if (!db) return {};

  const now = Date.now();
  const rawSince = now - RAW_WINDOW_MS;
  const rawSinceHb = hourBucket(rawSince);
  const retentionHb = hourBucket(now - retentionDays * DAY_MS);

  const [rollup, raw] = await Promise.all([
    db
      .prepare(
        `SELECT service, hb, ups, totals, lat_max
         FROM uptime_hourly
         WHERE hb >= ?1 AND hb <= ?2
         ORDER BY service, hb ASC`,
      )
      .bind(retentionHb, rawSinceHb)
      .all<{ service: string; hb: number; ups: number; totals: number; lat_max: number }>(),

    // Same worst-of-bucket decimation as the paid profile's one-time backfill
    // query, but with a single 1-minute tier and hard-bounded to 6 h so this
    // can never degrade into a full-table scan.
    db
      .prepare(
        `SELECT service, url, timestamp, latency, status, code, error
         FROM (
           SELECT service, url, timestamp, latency, status, code, error,
             ROW_NUMBER() OVER (
               PARTITION BY service, url, CAST(timestamp / 60000 AS INTEGER)
               ORDER BY
                 CASE WHEN status = 'down' THEN 0 ELSE 1 END,
                 latency DESC
             ) AS rn
           FROM checks
           WHERE timestamp > ?1 AND type IN ('https', 'secret')
         )
         WHERE rn = 1
         ORDER BY service, url, timestamp ASC`,
      )
      .bind(rawSince)
      .all<{
        service: string;
        url: string;
        timestamp: number;
        latency: number;
        status: string;
        code: number | null;
        error: string | null;
      }>(),
  ]);

  const out: ChartData = {};
  for (const r of rollup.results) {
    (out[r.service] ??= []).push([r.hb * HOUR_MS, r.lat_max, r.ups === r.totals ? 1 : 0]);
  }

  // One series per service: the first URL seen for a service is its primary,
  // matching the paid profile's chart state (which tracks `primaryUrl` only).
  const primaryUrls: Record<string, string> = {};
  for (const r of raw.results) {
    primaryUrls[r.service] ??= r.url;
    if (r.url !== primaryUrls[r.service]) continue;
    const pt: ChartDataPoint = [r.timestamp, r.latency, r.status === 'up' ? 1 : 0];
    if (r.code) pt.push(r.code);
    if (r.error) {
      if (pt.length === 3) pt.push(0); // code placeholder so error lands in slot 4
      pt.push(r.error);
    }
    (out[r.service] ??= []).push(pt);
  }

  return out;
}

/** Drop rollup rows past the retention window. Returns rows deleted.
 *  Deletes count against the 100,000 rows-written/day budget, so this is
 *  called on the plan's cleanup cadence, not every tick. */
export async function cleanupRollup(db: D1Database | undefined, retentionDays: number): Promise<number> {
  if (!db) return 0;
  const cutoffHb = hourBucket(Date.now() - retentionDays * DAY_MS);
  const result = await db.prepare(`DELETE FROM uptime_hourly WHERE hb < ?`).bind(cutoffHb).run();
  return result.meta.changes ?? 0;
}
