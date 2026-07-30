import type {
  PanelStatus,
  CheckResult,
  HistoryEntry,
  NotificationSettings,
  NotificationState,
  NotificationEventType,
  NotificationLogEntry,
  PushUrgency,
  LaneObservation,
  TransitionsState,
} from './types';
import type { PlanProfile } from './plan';
import { blobGet, blobPut, getChartFromRollup, getUptimeFromRollup } from './storage-free';

// ── Plan dispatch ────────────────────────────────────────────────────────────
// Every public function below that touches derived state takes the resolved
// `PlanProfile` as its first argument and branches on `plan.aggregateStore`.
//
//   'kv' (paid) — the original implementation, unchanged. Large precomputed KV
//                 blobs; D1 is never read from a request handler.
//   'd1' (free) — src/storage-free.ts. Small blobs move to the `blobs` table;
//                 the large chart/uptime blobs are not maintained at all and
//                 their data is derived from `uptime_hourly` on read.
//
// The paid path is a live production system: treat its branches as frozen.

/** True when the caller is on the free profile's D1 storage path. */
function useD1(plan: PlanProfile): boolean {
  return plan.aggregateStore === 'd1';
}

// Default history retention (30 days in ms). Callers pass the plan profile's
// `historyRetentionDays` instead; this is the paid profile's value, kept as the
// default so the paid behaviour is unchanged, and still used by the paid-only
// one-time backfills below.
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// ── KV hot-path cache ────────────────────────────────────────────────────────
// Dashboard status and last-checked times are batched into a single KV key
// to minimize writes (1 write/cron cycle instead of 2).

const KV_HOT_KEY = 'cache:hot';
const KV_DDNS_KEY = 'cache:ddns';

// Durable, incrementally-maintained derived state. No TTL — losing these means
// running a one-time D1 backfill to repopulate (see backfillChartTiered etc).
// They are the source of truth for chart + uptime on the read path; D1 is
// never consulted from request handlers.
const KV_CHART_TIERED_KEY = 'cache:chart-tiered';
const KV_UPTIME_BUCKETS_KEY = 'cache:uptime-buckets';
const KV_TRANSITIONS_KEY = 'cache:transitions';

interface HotCache {
  status: { panels: PanelStatus[]; lastUpdate: number };
  lastCheckedTimes: Record<string, number>;
}

/** Save current dashboard status + last-checked times (single write).
 *  Paid: one KV put. Free: one row in the D1 `blobs` table. */
export async function saveCurrentStatus(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  panels: PanelStatus[],
  lastCheckedTimes: Map<string, number>,
): Promise<void> {
  const hot: HotCache = {
    status: { panels, lastUpdate: Date.now() },
    lastCheckedTimes: Object.fromEntries(lastCheckedTimes),
  };
  if (useD1(plan)) {
    await blobPut(db, KV_HOT_KEY, JSON.stringify(hot));
    return;
  }
  if (!kv) return;
  await kv.put(KV_HOT_KEY, JSON.stringify(hot));
}

/** Get current dashboard status. Paid: KV-only — D1 is never read from the
 *  request path. Free: a single-row primary-key lookup in `blobs`. */
export async function getCurrentStatus(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
): Promise<{ panels: PanelStatus[]; lastUpdate: number } | null> {
  const raw = useD1(plan) ? await blobGet(db, KV_HOT_KEY) : kv ? await kv.get(KV_HOT_KEY) : null;
  if (!raw) return null;
  const hot: HotCache = JSON.parse(raw);
  return hot.status;
}

/** Save check results to history */
export async function addToHistory(db: D1Database | undefined, results: CheckResult[]): Promise<void> {
  if (!db || results.length === 0) return;

  // Batch insert all results
  const stmt = db.prepare(`
    INSERT INTO checks (service, url, type, status, code, latency, error, source, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = results.map(r =>
    stmt.bind(r.service, r.url, r.type, r.status, r.code ?? null, r.latency, r.error ?? null, r.source, r.timestamp),
  );

  await db.batch(batch);
}

/** Get history for a specific check */
export async function getCheckHistory(
  db: D1Database | undefined,
  serviceName: string,
  url: string,
  limit = 100,
): Promise<HistoryEntry[]> {
  if (!db) return [];

  const results = await db
    .prepare(
      `
    SELECT timestamp, status, latency, code, error
    FROM checks
    WHERE service = ? AND url = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `,
    )
    .bind(serviceName, url, limit)
    .all<{
      timestamp: number;
      status: string;
      latency: number;
      code: number | null;
      error: string | null;
    }>();

  return results.results.map(r => ({
    timestamp: r.timestamp,
    status: r.status as 'up' | 'down',
    latency: r.latency,
    code: r.code ?? undefined,
    error: r.error ?? undefined,
  }));
}

export interface UptimeByPeriod {
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  checkCount24h: number;
  checkCount7d: number;
  checkCount30d: number;
}

const HOUR_MS = 60 * 60 * 1000;

interface UptimeHourBucket {
  ups: number;
  totals: number;
}

/** Per-service per-hour up/total counters. Incrementally maintained by the
 *  minute cron via updateUptimeBuckets; durable (no TTL). */
type UptimeBucketsState = Record<string, Record<string, UptimeHourBucket>>;

function hourBucket(tsMs: number): number {
  return Math.floor(tsMs / HOUR_MS);
}

/** Get uptime stats for multiple time periods.
 *
 *  Paid: reads incrementally-maintained KV state — never queries D1. If state
 *  is missing (fresh deploy before backfill), returns {}.
 *  Free: one grouped query over the `uptime_hourly` rollup. */
export async function getMultiPeriodUptime(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
): Promise<Record<string, UptimeByPeriod>> {
  if (useD1(plan)) return getUptimeFromRollup(db, plan.historyRetentionDays);
  if (!kv) return {};
  const raw = await kv.get(KV_UPTIME_BUCKETS_KEY);
  if (!raw) return {};
  const state = JSON.parse(raw) as UptimeBucketsState;

  const nowHb = hourBucket(Date.now());
  const cutoff24h = nowHb - 24;
  const cutoff7d = nowHb - 7 * 24;
  const cutoff30d = nowHb - 30 * 24;

  const stats: Record<string, UptimeByPeriod> = {};
  for (const [service, buckets] of Object.entries(state)) {
    let up24h = 0,
      total24h = 0,
      up7d = 0,
      total7d = 0,
      up30d = 0,
      total30d = 0;
    for (const [hbStr, { ups, totals }] of Object.entries(buckets)) {
      const hb = Number(hbStr);
      if (hb >= cutoff30d) {
        up30d += ups;
        total30d += totals;
      }
      if (hb >= cutoff7d) {
        up7d += ups;
        total7d += totals;
      }
      if (hb >= cutoff24h) {
        up24h += ups;
        total24h += totals;
      }
    }
    stats[service] = {
      uptime24h: total24h > 0 ? (up24h / total24h) * 100 : null,
      uptime7d: total7d > 0 ? (up7d / total7d) * 100 : null,
      uptime30d: total30d > 0 ? (up30d / total30d) * 100 : null,
      checkCount24h: total24h,
      checkCount7d: total7d,
      checkCount30d: total30d,
    };
  }
  return stats;
}

/** Incrementally update per-service per-hour up/total counters from fresh
 *  check results, age out buckets >30d, and self-backfill from D1 the first
 *  time the KV blob is missing. Single KV read on the steady-state path.
 *
 *  Free: no-op. The equivalent counters live in `uptime_hourly`, maintained by
 *  `rollUpHourly` from the cron — this blob is never created on that plan. */
export async function updateUptimeBuckets(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  freshResults: CheckResult[],
): Promise<void> {
  if (useD1(plan)) return;
  if (!kv) return;
  const raw = await kv.get(KV_UPTIME_BUCKETS_KEY);
  if (raw === null) {
    if (db) {
      console.log('Backfilling uptime-buckets KV state from D1 (one-time)...');
      await backfillUptimeBuckets(kv, db);
    }
    return;
  }
  if (freshResults.length === 0) return;
  const state = JSON.parse(raw) as UptimeBucketsState;

  for (const r of freshResults) {
    const hbKey = String(hourBucket(r.timestamp));
    const svc = (state[r.service] ??= {});
    const bucket = (svc[hbKey] ??= { ups: 0, totals: 0 });
    bucket.totals++;
    if (r.status === 'up') bucket.ups++;
  }

  const cutoff = hourBucket(Date.now()) - 30 * 24;
  for (const svc of Object.keys(state)) {
    for (const hbKey of Object.keys(state[svc])) {
      if (Number(hbKey) < cutoff) delete state[svc][hbKey];
    }
  }

  await kv.put(KV_UPTIME_BUCKETS_KEY, JSON.stringify(state));
}

/** One-shot backfill of the uptime buckets blob from `checks`. Called by
 *  updateUptimeBuckets when the KV blob is missing; only runs on first
 *  deploy (or recovery if KV state is lost). */
export async function backfillUptimeBuckets(kv: KVNamespace, db: D1Database): Promise<void> {
  const since = Date.now() - HISTORY_RETENTION_MS;
  const results = await db
    .prepare(
      `SELECT service,
              CAST(timestamp / ${HOUR_MS} AS INTEGER) AS hb,
              COUNT(*) AS totals,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS ups
       FROM checks
       WHERE timestamp > ?
       GROUP BY service, hb`,
    )
    .bind(since)
    .all<{ service: string; hb: number; totals: number; ups: number }>();

  const state: UptimeBucketsState = {};
  for (const r of results.results) {
    (state[r.service] ??= {})[String(r.hb)] = { ups: r.ups, totals: r.totals };
  }
  await kv.put(KV_UPTIME_BUCKETS_KEY, JSON.stringify(state));
}

/** Get the most recent check timestamp per service (for stochastic ordering).
 *  Reads the same hot blob as `getCurrentStatus` — KV on paid, the `blobs`
 *  table on free. If it is missing, returns empty: the next cron tick rebuilds
 *  it as fresh checks complete. */
export async function getLastCheckedTimes(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
): Promise<Map<string, number>> {
  const raw = useD1(plan) ? await blobGet(db, KV_HOT_KEY) : kv ? await kv.get(KV_HOT_KEY) : null;
  if (!raw) return new Map();
  const hot: HotCache = JSON.parse(raw);
  return new Map(Object.entries(hot.lastCheckedTimes));
}

/** Delete all history for a specific service */
export async function deleteServiceHistory(db: D1Database | undefined, service: string): Promise<number> {
  if (!db) return 0;

  const result = await db.prepare(`DELETE FROM checks WHERE service = ?`).bind(service).run();
  return result.meta.changes ?? 0;
}

/** Clean up old history entries. `retentionDays` comes from the plan profile
 *  (30 on paid, 7 on free); the default matches the paid profile. */
export async function cleanupHistory(db: D1Database | undefined, retentionDays = 30): Promise<number> {
  if (!db) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const result = await db
    .prepare(
      `
    DELETE FROM checks WHERE timestamp < ?
  `,
    )
    .bind(cutoff)
    .run();

  return result.meta.changes ?? 0;
}

/** Chart data for all HTTPS endpoints with logarithmic time decimation.
 *  Returns more points for recent data and fewer for older data,
 *  optimized for display on a power-law time axis.
 *
 *  Tier buckets (worst-of-bucket selection preserves outages):
 *    Last 6h  → 1-min   (~360 pts/service)
 *    6h–2d    → 10-min  (~216 pts/service)
 *    2d–7d    → 30-min  (~240 pts/service)
 *    7d–30d+  → 2-hour  (~276 pts/service)
 *
 *  State is maintained incrementally per cron tick (see updateChartTiered);
 *  the read path never touches D1.
 */

/** Compact chart point: [timestamp, latency, statusBit, code?, error?]
 *  statusBit: 1 = up, 0 = down.  Trailing fields omitted when absent. */
export type ChartDataPoint = [ts: number, lat: number, up: number, code?: number, error?: string];
export type ChartData = Record<string, ChartDataPoint[]>;

const MIN_MS = 60_000;
const T1_MAX_AGE_MS = 6 * 60 * MIN_MS;
const T10_MAX_AGE_MS = 2 * 24 * 60 * MIN_MS;
const T30_MAX_AGE_MS = 7 * 24 * 60 * MIN_MS;
const T120_MAX_AGE_MS = 30 * 24 * 60 * MIN_MS;
const T10_BUCKET_MS = 10 * MIN_MS;
const T30_BUCKET_MS = 30 * MIN_MS;
const T120_BUCKET_MS = 120 * MIN_MS;

interface ServiceTiers {
  primaryUrl: string;
  t1: ChartDataPoint[];
  t10: ChartDataPoint[];
  t30: ChartDataPoint[];
  t120: ChartDataPoint[];
}

type ChartTieredState = Record<string, ServiceTiers>;

function encodePoint(r: CheckResult): ChartDataPoint {
  const pt: ChartDataPoint = [r.timestamp, r.latency, r.status === 'up' ? 1 : 0];
  if (r.code) pt.push(r.code);
  if (r.error) {
    if (pt.length === 3) pt.push(0); // code placeholder so error slot is 4
    pt.push(r.error);
  }
  return pt;
}

/** "Down beats up; tied → higher latency wins" — matches the existing
 *  decimation query's ORDER BY clause. */
function isWorse(a: ChartDataPoint, b: ChartDataPoint): boolean {
  const aDown = a[2] === 0;
  const bDown = b[2] === 0;
  if (aDown !== bDown) return aDown && !bDown;
  return a[1] > b[1];
}

/** Insert a point into a per-tier sorted array, applying worst-of-bucket if
 *  another point already lives in the same bucket. Array stays sorted by ts ASC. */
function mergeIntoBucket(arr: ChartDataPoint[], pt: ChartDataPoint, bucketWidthMs: number): void {
  const newBucket = Math.floor(pt[0] / bucketWidthMs);
  for (let i = 0; i < arr.length; i++) {
    const b = Math.floor(arr[i][0] / bucketWidthMs);
    if (b === newBucket) {
      if (isWorse(pt, arr[i])) arr[i] = pt;
      return;
    }
    if (b > newBucket) {
      arr.splice(i, 0, pt);
      return;
    }
  }
  arr.push(pt);
}

/** Move points from t1→t10→t30→t120 as they age past tier boundaries; drop
 *  points older than 30d from t120. */
function promoteTiers(svc: ServiceTiers, now: number): void {
  const limits: Array<
    [keyof ServiceTiers & ('t1' | 't10' | 't30'), keyof ServiceTiers & ('t10' | 't30' | 't120'), number, number]
  > = [
    ['t1', 't10', now - T1_MAX_AGE_MS, T10_BUCKET_MS],
    ['t10', 't30', now - T10_MAX_AGE_MS, T30_BUCKET_MS],
    ['t30', 't120', now - T30_MAX_AGE_MS, T120_BUCKET_MS],
  ];
  for (const [src, dst, ageLimit, bucketWidth] of limits) {
    const keep: ChartDataPoint[] = [];
    const promo: ChartDataPoint[] = [];
    for (const p of svc[src]) (p[0] < ageLimit ? promo : keep).push(p);
    svc[src] = keep;
    for (const p of promo) mergeIntoBucket(svc[dst], p, bucketWidth);
  }
  const dropLimit = now - T120_MAX_AGE_MS;
  svc.t120 = svc.t120.filter(p => p[0] >= dropLimit);
}

/** Get chart data for all services.
 *
 *  Paid: KV-only — never queries D1. Returns empty {} if state is missing
 *  (fresh deploy before backfill).
 *  Free: assembled from the `uptime_hourly` rollup plus the last 6 h of raw
 *  `checks` rows (two bounded queries; never a full-table scan). */
export async function getChartData(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
): Promise<ChartData> {
  if (useD1(plan)) return getChartFromRollup(db, plan.historyRetentionDays);
  if (!kv) return {};
  const raw = await kv.get(KV_CHART_TIERED_KEY);
  if (!raw) return {};
  const state = JSON.parse(raw) as ChartTieredState;
  const out: ChartData = {};
  for (const [service, tiers] of Object.entries(state)) {
    out[service] = [...tiers.t120, ...tiers.t30, ...tiers.t10, ...tiers.t1];
  }
  return out;
}

/** Incrementally update the tiered chart state from fresh HTTPS primary-URL
 *  check results (worst-of-bucket merge into t1, then tier promotion), and
 *  self-backfill from D1 the first time the KV blob is missing. Single KV
 *  read on the steady-state path.
 *
 *  Free: no-op. This blob is the ~2.8 MB one — parsing and re-stringifying it
 *  every tick is exactly what the 10 ms CPU limit forbids. The free path
 *  derives chart data from `uptime_hourly` on read instead. */
export async function updateChartTiered(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  freshResults: CheckResult[],
): Promise<void> {
  if (useD1(plan)) return;
  if (!kv) return;
  const raw = await kv.get(KV_CHART_TIERED_KEY);
  if (raw === null) {
    if (db) {
      console.log('Backfilling chart-tiered KV state from D1 (one-time)...');
      await backfillChartTiered(kv, db);
    }
    return;
  }
  if (freshResults.length === 0) return;
  const state = JSON.parse(raw) as ChartTieredState;
  const now = Date.now();

  for (const r of freshResults) {
    if (r.type !== 'https') continue;
    let svc = state[r.service];
    if (!svc) {
      svc = state[r.service] = { primaryUrl: r.url, t1: [], t10: [], t30: [], t120: [] };
    }
    if (r.url !== svc.primaryUrl) continue;
    mergeIntoBucket(svc.t1, encodePoint(r), MIN_MS);
  }

  for (const svc of Object.values(state)) promoteTiers(svc, now);

  await kv.put(KV_CHART_TIERED_KEY, JSON.stringify(state));
}

/** One-shot D1 → tiered KV state. Called by updateChartTiered when the KV
 *  blob is missing; only runs on first deploy (or recovery if KV state is
 *  lost). Reads ~one chart-query worth of D1 rows; ~$0.01 one-time. */
export async function backfillChartTiered(kv: KVNamespace, db: D1Database): Promise<void> {
  const since = Date.now() - HISTORY_RETENTION_MS;
  const { data, primaryUrls } = await queryChartDataFromDB(db, since);
  const state: ChartTieredState = {};
  const now = Date.now();
  for (const [service, points] of Object.entries(data)) {
    const tiers: ServiceTiers = { primaryUrl: primaryUrls[service], t1: [], t10: [], t30: [], t120: [] };
    for (const pt of points) {
      const age = now - pt[0];
      if (age < T1_MAX_AGE_MS) tiers.t1.push(pt);
      else if (age < T10_MAX_AGE_MS) tiers.t10.push(pt);
      else if (age < T30_MAX_AGE_MS) tiers.t30.push(pt);
      else tiers.t120.push(pt);
    }
    state[service] = tiers;
  }
  await kv.put(KV_CHART_TIERED_KEY, JSON.stringify(state));
}

/** Run the expensive tiered decimation query against D1. Used exclusively by
 *  backfillChartTiered — no longer called from the request path. */
async function queryChartDataFromDB(
  db: D1Database,
  since: number,
): Promise<{ data: ChartData; primaryUrls: Record<string, string> }> {
  const now = Date.now();
  const since6h = now - T1_MAX_AGE_MS;
  const since2d = now - T10_MAX_AGE_MS;
  const since7d = now - T30_MAX_AGE_MS;

  const results = await db
    .prepare(
      `
    SELECT service, url, timestamp, latency, status, code, error
    FROM (
      SELECT service, url, timestamp, latency, status, code, error,
        ROW_NUMBER() OVER (
          PARTITION BY service, url,
            CASE
              WHEN timestamp > ?1 THEN CAST(timestamp / 60000 AS INTEGER)
              WHEN timestamp > ?2 THEN CAST(timestamp / 600000 AS INTEGER)
              WHEN timestamp > ?3 THEN CAST(timestamp / 1800000 AS INTEGER)
              ELSE CAST(timestamp / 7200000 AS INTEGER)
            END
          ORDER BY
            CASE WHEN status = 'down' THEN 0 ELSE 1 END,
            latency DESC
        ) AS rn
      FROM checks
      WHERE timestamp > ?4 AND type = 'https'
    )
    WHERE rn = 1
    ORDER BY service, url, timestamp ASC
  `,
    )
    .bind(since6h, since2d, since7d, since)
    .all<{
      service: string;
      url: string;
      timestamp: number;
      latency: number;
      status: string;
      code: number | null;
      error: string | null;
    }>();

  const grouped: ChartData = {};
  const primaryUrls: Record<string, string> = {};
  for (const r of results.results) {
    if (!primaryUrls[r.service]) {
      primaryUrls[r.service] = r.url;
      grouped[r.service] = [];
    }
    if (r.url === primaryUrls[r.service]) {
      const pt: ChartDataPoint = [r.timestamp, r.latency, r.status === 'up' ? 1 : 0];
      if (r.code) pt.push(r.code);
      if (r.error) {
        if (pt.length === 3) pt.push(0);
        pt.push(r.error);
      }
      grouped[r.service].push(pt);
    }
  }
  return { data: grouped, primaryUrls };
}

// ── Transition timeline (correlation swimlanes) ──────────────────────────────
// Sparse, durable KV state: one lane per service / GitHub workflow / DDNS client,
// storing only state *flips* (not per-minute samples). Maintained incrementally
// per cron tick (see updateTransitions), KV-only on the read path. Because flips
// are rare, retention is long and the blob stays small.

/** How long to keep transition history (90 days). Flips are sparse, so this is cheap. */
const TRANSITIONS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Hard per-lane cap on stored transitions. The design assumes flips are rare; a
 *  flapping entity (oscillating every tick) would otherwise grow a lane's array
 *  ~1,440/day and force a write every minute. This bounds memory, CPU (per-tick
 *  parse/stringify), and KV value size regardless of flap rate — we keep the most
 *  recent N flips and drop the oldest. */
const MAX_TRANSITIONS_PER_LANE = 1000;

/** Get all timeline lanes. Paid: KV-only — never queries D1. Free: one row from
 *  the `blobs` table (the lane blob is sparse, so it stays small). Returns {}
 *  if missing. */
export async function getTransitions(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
): Promise<TransitionsState> {
  const raw = useD1(plan) ? await blobGet(db, KV_TRANSITIONS_KEY) : kv ? await kv.get(KV_TRANSITIONS_KEY) : null;
  if (!raw) return {};
  return JSON.parse(raw) as TransitionsState;
}

/** Apply a batch of lane observations: seed new lanes, append a transition when a
 *  lane's state flips, prune history past retention, and persist — but only write
 *  KV when something actually changed. Flips are rare, so the steady state is a
 *  single KV read per tick and zero writes (vs. an unconditional write/minute).
 *  Forward-only — no D1 backfill; history accrues from first observation.
 *
 *  Free uses the same logic against the `blobs` table. The dirty gate matters
 *  even more there: a write per tick would be 288 needless D1 row-writes a day
 *  for state that rarely changes. */
export async function updateTransitions(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  observations: LaneObservation[],
): Promise<void> {
  const d1 = useD1(plan);
  if (observations.length === 0) return;
  if (d1 ? !db : !kv) return;
  const raw = d1 ? await blobGet(db, KV_TRANSITIONS_KEY) : ((await kv?.get(KV_TRANSITIONS_KEY)) ?? null);
  const state: TransitionsState = raw ? (JSON.parse(raw) as TransitionsState) : {};
  let changed = false;

  for (const obs of observations) {
    const lane = state[obs.key];
    if (!lane) {
      // First time we've seen this lane: seed it with an opening segment.
      state[obs.key] = {
        kind: obs.kind,
        label: obs.label,
        link: obs.link,
        current: obs.up,
        lastSeen: obs.ts,
        transitions: [{ ts: obs.ts, up: obs.up, detail: obs.detail }],
      };
      changed = true;
      continue;
    }
    // Persist display metadata only when it actually changes (e.g. a config
    // rename) — not every tick, which would force a needless write.
    if (lane.label !== obs.label || lane.link !== obs.link) {
      lane.label = obs.label;
      lane.link = obs.link;
      changed = true;
    }
    lane.lastSeen = obs.ts; // in-memory only; persisted opportunistically on the next real change
    if (obs.up !== lane.current) {
      lane.current = obs.up;
      lane.transitions.push({ ts: obs.ts, up: obs.up, detail: obs.detail });
      changed = true;
    }
  }

  // Prune transitions older than retention, but keep the most recent one at/before
  // the cutoff so each lane has a defined state entering the visible window.
  const cutoff = Date.now() - TRANSITIONS_RETENTION_MS;
  for (const lane of Object.values(state)) {
    const ts = lane.transitions;
    if (ts.length <= 1) continue;
    let lastBefore = 0;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i].ts <= cutoff) lastBefore = i;
      else break;
    }
    if (lastBefore > 0) {
      lane.transitions = ts.slice(lastBefore);
      changed = true;
    }
    // Safety cap: a flapping lane can outrun retention — keep only the most recent N.
    if (lane.transitions.length > MAX_TRANSITIONS_PER_LANE) {
      lane.transitions = lane.transitions.slice(-MAX_TRANSITIONS_PER_LANE);
      changed = true;
    }
  }

  if (changed) {
    const json = JSON.stringify(state);
    if (d1) await blobPut(db, KV_TRANSITIONS_KEY, json);
    else await kv?.put(KV_TRANSITIONS_KEY, json);
  }
}

export interface DdnsLogEntry {
  id: number;
  event: 'ip_change' | 'no_change' | 'rejected' | 'not_found' | 'error';
  hostname: string | null;
  zone: string | null;
  old_ip: string | null;
  new_ip: string | null;
  source_ip: string | null;
  path: string;
  status_code: number;
  message: string;
  timestamp: number;
}

/** Get recent DDNS log entries, optionally filtered by event type.
 *
 *  Paid: unfiltered requests with the default limit are KV-cached (refreshed
 *  by cron), because a D1 read on the request path is the thing to avoid.
 *  Free: always query D1. There is no cache to consult — warming one would
 *  cost a KV write per tick out of a 1,000/day budget, to save an indexed
 *  200-row query that the 5M rows-scanned/day budget absorbs easily. */
export async function getRecentDdnsLog(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  event?: string,
  limit = 200,
): Promise<DdnsLogEntry[]> {
  // KV cache only for the default unfiltered query (used by dashboard + poll)
  if (!useD1(plan) && !event && kv) {
    const cached = await kv.get(KV_DDNS_KEY);
    if (cached) {
      const entries = JSON.parse(cached) as DdnsLogEntry[];
      return entries.slice(0, limit);
    }
  }

  if (!db) return [];

  const query = event
    ? `SELECT id, event, hostname, zone, old_ip, new_ip, source_ip, path, status_code, message, timestamp
       FROM ddns_log WHERE event = ?
       ORDER BY timestamp DESC LIMIT ?`
    : `SELECT id, event, hostname, zone, old_ip, new_ip, source_ip, path, status_code, message, timestamp
       FROM ddns_log
       ORDER BY timestamp DESC LIMIT ?`;

  const stmt = db.prepare(query);
  const bound = event ? stmt.bind(event, limit) : stmt.bind(limit);

  const results = await bound.all<DdnsLogEntry>();
  return results.results;
}

/** Timestamp (ms) of the most recent successful update for a DDNS hostname,
 *  or null if it has never successfully checked in. A "success" is the gateway
 *  reaching the worker and the record being either updated or already correct
 *  (ip_change / no_change) — i.e. proof the client is alive. */
export async function getLatestDdnsSuccess(db: D1Database | undefined, hostname: string): Promise<number | null> {
  if (!db) return null;
  const row = await db
    .prepare(
      `SELECT MAX(timestamp) AS latest
       FROM ddns_log
       WHERE hostname = ? AND event IN ('no_change', 'ip_change')`,
    )
    .bind(hostname)
    .first<{ latest: number | null }>();
  return row?.latest ?? null;
}

/** DDNS `ip_change` events with id greater than `sinceId`, oldest first.
 *  Used to alert on actual IP updates; the caller advances its cursor to the
 *  newest id it has notified. */
export async function getDdnsIpChangesSince(
  db: D1Database | undefined,
  sinceId: number,
  limit = 25,
): Promise<DdnsLogEntry[]> {
  if (!db) return [];
  const results = await db
    .prepare(
      `SELECT id, event, hostname, zone, old_ip, new_ip, source_ip, path, status_code, message, timestamp
       FROM ddns_log
       WHERE event = 'ip_change' AND id > ?
       ORDER BY id ASC LIMIT ?`,
    )
    .bind(sinceId, limit)
    .all<DdnsLogEntry>();
  return results.results;
}

/** Refresh the KV DDNS log cache from D1 (called by cron job).
 *
 *  `ttlSeconds` must outlive the gap between cron ticks — this is the only KV
 *  blob with an expiry, and once it lapses every dashboard request falls back
 *  to a 200-row D1 query. Derive it from the plan profile
 *  (`ddnsCacheTtlSeconds`) rather than hardcoding. KV rejects TTLs under 60s.
 *
 *  Free: no-op — that plan has no KV cache to warm (see getRecentDdnsLog). */
export async function refreshDdnsCache(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  ttlSeconds = 180,
): Promise<void> {
  if (useD1(plan)) return;
  if (!kv || !db) return;
  const entries = await getRecentDdnsLog(plan, undefined, db, undefined, 200);
  await kv.put(KV_DDNS_KEY, JSON.stringify(entries), { expirationTtl: Math.max(60, ttlSeconds) });
}

/** Get recent check errors (status = 'down'), optionally filtered by service */
export async function getRecentErrors(
  db: D1Database | undefined,
  service?: string,
  limit = 100,
): Promise<
  {
    service: string;
    url: string;
    type: string;
    code: number | null;
    error: string | null;
    latency: number;
    source: string;
    timestamp: number;
  }[]
> {
  if (!db) return [];

  const query = service
    ? `SELECT service, url, type, code, error, latency, source, timestamp
       FROM checks WHERE status = 'down' AND service = ?
       ORDER BY timestamp DESC LIMIT ?`
    : `SELECT service, url, type, code, error, latency, source, timestamp
       FROM checks WHERE status = 'down'
       ORDER BY timestamp DESC LIMIT ?`;

  const stmt = db.prepare(query);
  const bound = service ? stmt.bind(service, limit) : stmt.bind(limit);

  const results = await bound.all<{
    service: string;
    url: string;
    type: string;
    code: number | null;
    error: string | null;
    latency: number;
    source: string;
    timestamp: number;
  }>();

  return results.results;
}

/** Clean up old DDNS log entries (older than 1 year) */
export async function cleanupDdnsLog(db: D1Database | undefined): Promise<number> {
  if (!db) return 0;

  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year

  const result = await db.prepare(`DELETE FROM ddns_log WHERE timestamp < ?`).bind(cutoff).run();

  return result.meta.changes ?? 0;
}

// ============================================
// Push Subscription Storage
// ============================================

export interface StoredPushSubscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  last_notified: number | null;
}

/** Upsert a push subscription (insert or update keys for existing endpoint) */
export async function addPushSubscription(
  db: D1Database | undefined,
  endpoint: string,
  p256dh: string,
  auth: string,
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .bind(endpoint, p256dh, auth, Date.now())
    .run();
}

/** Remove a push subscription by endpoint */
export async function removePushSubscription(db: D1Database | undefined, endpoint: string): Promise<void> {
  if (!db) return;
  await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
}

/** Remove a push subscription by ID */
export async function removePushSubscriptionById(db: D1Database | undefined, id: number): Promise<boolean> {
  if (!db) return false;
  const result = await db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Retrieve all stored push subscriptions */
export async function getAllPushSubscriptions(db: D1Database | undefined): Promise<StoredPushSubscription[]> {
  if (!db) return [];
  const result = await db
    .prepare(`SELECT id, endpoint, p256dh, auth, created_at, last_notified FROM push_subscriptions`)
    .all<StoredPushSubscription>();
  return result.results;
}

/** Update the last_notified timestamp for a subscription */
export async function updateLastNotified(db: D1Database | undefined, endpoint: string): Promise<void> {
  if (!db) return;
  await db
    .prepare(`UPDATE push_subscriptions SET last_notified = ? WHERE endpoint = ?`)
    .bind(Date.now(), endpoint)
    .run();
}

// ============================================
// Notification Settings Storage
// ============================================

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: 0,
  failure_threshold: 1,
  notify_recovery: 0,
  urgency: null,
};

const DEFAULT_NOTIFICATION_STATE: NotificationState = {
  consecutive_down: 0,
  notified_down: 0,
};

/** Get notification settings for a key, returning defaults if not set */
export async function getNotificationSettings(db: D1Database | undefined, key: string): Promise<NotificationSettings> {
  if (!db) return { ...DEFAULT_NOTIFICATION_SETTINGS };

  const row = await db
    .prepare(
      `SELECT enabled, failure_threshold, notify_recovery, urgency
       FROM notification_settings WHERE key = ?`,
    )
    .bind(key)
    .first<{
      enabled: number;
      failure_threshold: number;
      notify_recovery: number;
      urgency: string | null;
    }>();

  if (!row) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  return { ...row, urgency: row.urgency as NotificationSettings['urgency'] };
}

/** Upsert user-facing notification settings for a key; resets runtime state so no stale notification fires. */
export async function setNotificationSettings(
  db: D1Database | undefined,
  key: string,
  settings: NotificationSettings,
): Promise<void> {
  if (!db) return;
  await db.batch([
    db
      .prepare(
        `INSERT INTO notification_settings (key, enabled, failure_threshold, notify_recovery, urgency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           enabled = excluded.enabled,
           failure_threshold = excluded.failure_threshold,
           notify_recovery = excluded.notify_recovery,
           urgency = excluded.urgency,
           updated_at = excluded.updated_at`,
      )
      .bind(key, settings.enabled, settings.failure_threshold, settings.notify_recovery, settings.urgency, Date.now()),
    // Reset runtime state so a settings change never immediately triggers a notification
    db
      .prepare(
        `INSERT INTO notification_state (key, consecutive_down, notified_down)
         VALUES (?, 0, 0)
         ON CONFLICT(key) DO UPDATE SET consecutive_down = 0, notified_down = 0`,
      )
      .bind(key),
  ]);
}

/** Get all notification settings rows */
export async function getAllNotificationSettings(
  db: D1Database | undefined,
): Promise<Record<string, NotificationSettings>> {
  if (!db) return {};
  const result = await db
    .prepare(
      `SELECT key, enabled, failure_threshold, notify_recovery, urgency
       FROM notification_settings`,
    )
    .all<{
      key: string;
      enabled: number;
      failure_threshold: number;
      notify_recovery: number;
      urgency: string | null;
    }>();

  const map: Record<string, NotificationSettings> = {};
  for (const row of result.results) {
    const { key, ...rest } = row;
    map[key] = { ...rest, urgency: rest.urgency as NotificationSettings['urgency'] };
  }
  return map;
}

/** Get runtime notification state for a key */
export async function getNotificationState(db: D1Database | undefined, key: string): Promise<NotificationState> {
  if (!db) return { ...DEFAULT_NOTIFICATION_STATE };

  const row = await db
    .prepare(`SELECT consecutive_down, notified_down FROM notification_state WHERE key = ?`)
    .bind(key)
    .first<{ consecutive_down: number; notified_down: number }>();

  return row ?? { ...DEFAULT_NOTIFICATION_STATE };
}

/** Get all runtime notification states */
export async function getAllNotificationStates(db: D1Database | undefined): Promise<Record<string, NotificationState>> {
  if (!db) return {};
  const result = await db
    .prepare(`SELECT key, consecutive_down, notified_down FROM notification_state`)
    .all<{ key: string } & NotificationState>();

  const map: Record<string, NotificationState> = {};
  for (const row of result.results) {
    const { key, ...state } = row;
    map[key] = state;
  }
  return map;
}

/** Update runtime notification state (consecutive_down, notified_down) for a key */
export async function updateNotificationState(
  db: D1Database | undefined,
  key: string,
  consecutiveDown: number,
  notifiedDown: number,
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO notification_state (key, consecutive_down, notified_down)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         consecutive_down = excluded.consecutive_down,
         notified_down = excluded.notified_down`,
    )
    .bind(key, consecutiveDown, notifiedDown)
    .run();
}

/** Batch-update multiple notification states in a single transaction */
export async function batchUpdateNotificationStates(
  db: D1Database | undefined,
  updates: { key: string; consecutiveDown: number; notifiedDown: number }[],
): Promise<void> {
  if (!db || updates.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO notification_state (key, consecutive_down, notified_down)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       consecutive_down = excluded.consecutive_down,
       notified_down = excluded.notified_down`,
  );
  await db.batch(updates.map(u => stmt.bind(u.key, u.consecutiveDown, u.notifiedDown)));
}

// ============================================
// Notification Log
// ============================================

/** Log a notification event (one row per send, not per subscriber). */
export async function addNotificationLogEntry(
  db: D1Database | undefined,
  entry: {
    key: string;
    type: NotificationEventType;
    title: string;
    body: string;
    urgency: PushUrgency | null;
    subscribersNotified: number;
    delivered: boolean;
  },
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO notification_log (key, type, title, body, urgency, subscribers_notified, delivered, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.key,
      entry.type,
      entry.title,
      entry.body,
      entry.urgency,
      entry.subscribersNotified,
      entry.delivered ? 1 : 0,
      Date.now(),
    )
    .run();
}

/** Get recent notification log entries, with optional filters. */
export async function getNotificationLog(
  db: D1Database | undefined,
  options?: {
    key?: string;
    type?: string;
    since?: number;
    limit?: number;
  },
): Promise<NotificationLogEntry[]> {
  if (!db) return [];

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.key) {
    conditions.push('key = ?');
    params.push(options.key);
  }
  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  if (options?.since) {
    conditions.push('timestamp > ?');
    params.push(options.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 200;
  params.push(limit);

  const result = await db
    .prepare(
      `SELECT id, key, type, title, body, urgency, subscribers_notified, delivered, timestamp
       FROM notification_log ${where}
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .bind(...params)
    .all<NotificationLogEntry>();

  return result.results;
}

/** Delete old notification log entries (default: older than 90 days). */
export async function cleanupNotificationLog(db: D1Database | undefined, retentionMs?: number): Promise<number> {
  if (!db) return 0;
  const cutoff = Date.now() - (retentionMs ?? 90 * 24 * 60 * 60 * 1000);
  const result = await db.prepare(`DELETE FROM notification_log WHERE timestamp < ?`).bind(cutoff).run();
  return result.meta.changes ?? 0;
}
