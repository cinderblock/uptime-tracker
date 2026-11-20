/**
 * Dashboard rollups for the paid profile: the latency chart tiers and the
 * per-hour uptime counters. (The free profile keeps its aggregates in D1
 * instead; see storage-free.ts. storage.ts dispatches between the two.)
 *
 * Both are derived from check results and kept in KV, so the read path never
 * queries D1. Each is split by how often it changes:
 *
 *   Cold (`cache:chart-tiered`, `cache:uptime-buckets`): everything before the
 *   current hour. Megabytes of JSON. Rewritten once an hour, when the first tick
 *   of a new hour folds the previous hour in.
 *
 *   Recent (`cache:rollups-recent`): the current hour only. A few tens of KB.
 *   Rewritten every tick.
 *
 * Before this split, every tick parsed, updated and re-serialised both cold
 * blobs (2.2 MB and 1.3 MB in production on 2026-11-13). That was ~55 ms of CPU
 * per tick on a desktop, most of the cron's CPU, to change a few hundred points.
 * Measured on the ops deployment: cron CPU p50 146 → 78 ms.
 *
 * Readers combine the two: cold (memoized until the next fold, keyed by
 * `coldGen`) plus recent. The cold blobs keep their pre-split format, so the
 * split needs no data migration.
 */

import { checksSince, unionChecks } from './check-tables';
import type { GenerationMemo } from './read-memo';
import type { CheckResult } from './types';

/** How long rollups keep history. Matches the paid profile's `checks` retention. */
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

const KV_CHART_TIERED_KEY = 'cache:chart-tiered';
const KV_UPTIME_BUCKETS_KEY = 'cache:uptime-buckets';
const KV_RECENT_KEY = 'cache:rollups-recent';

export function hourBucket(tsMs: number): number {
  return Math.floor(tsMs / HOUR_MS);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface UptimeByPeriod {
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  checkCount24h: number;
  checkCount7d: number;
  checkCount30d: number;
}

interface UptimeHourBucket {
  ups: number;
  totals: number;
}

/** Per-service, per-hour up/total counters, keyed by hour bucket. */
type UptimeBucketsState = Record<string, Record<string, UptimeHourBucket>>;

/** Compact chart point: [timestamp, latency, statusBit, code?, error?]
 *  statusBit: 1 = up, 0 = down.  Trailing fields omitted when absent. */
export type ChartDataPoint = [ts: number, lat: number, up: number, code?: number, error?: string];
export type ChartData = Record<string, ChartDataPoint[]>;

/** Chart data for each service's primary check (its first HTTPS check, or a
 *  secret service's one direct check), with logarithmic time decimation.
 *  More points for recent data, fewer for older, for a power-law time axis.
 *
 *  Tier buckets (worst-of-bucket selection preserves outages):
 *    Last 6h  → 1-min   (~360 pts/service, up to an hour more between folds)
 *    6h–2d    → 10-min  (~216 pts/service)
 *    2d–7d    → 30-min  (~240 pts/service)
 *    7d–30d+  → 2-hour  (~276 pts/service)
 */
const T1_MAX_AGE_MS = 6 * HOUR_MS;
const T10_MAX_AGE_MS = 2 * 24 * HOUR_MS;
const T30_MAX_AGE_MS = 7 * 24 * HOUR_MS;
const T120_MAX_AGE_MS = 30 * 24 * HOUR_MS;
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

/** The current hour's rollups. Small; rewritten every tick. */
export interface RecentRollups {
  /** Hour bucket this blob is accumulating. A tick in a later hour folds it. */
  hour: number;
  /** When the cold blobs were last written (ms). Readers key their memo on it. */
  coldGen: number;
  /** Service → the URL its chart follows (see isPrimaryType). Carried here
   *  so a tick can filter points without reading the cold chart. */
  primaryUrls: Record<string, string>;
  /** Service → this hour's 1-minute chart points, ascending. */
  chart: ChartData;
  /** Service → hour bucket → counters. Normally only `hour`, but a result
   *  stamped in the previous hour stays in its own bucket. */
  uptime: UptimeBucketsState;
}

// ── Chart point helpers ──────────────────────────────────────────────────────

/** Check types that can be a service's charted primary check. A secret
 *  service's one direct check is its primary check. */
function isPrimaryType(type: string): boolean {
  return type === 'https' || type === 'secret';
}

function encodePoint(r: CheckResult): ChartDataPoint {
  const pt: ChartDataPoint = [r.timestamp, r.latency, r.status === 'up' ? 1 : 0];
  if (r.code) pt.push(r.code);
  if (r.error) {
    if (pt.length === 3) pt.push(0); // code placeholder so error slot is 4
    pt.push(r.error);
  }
  return pt;
}

/** "Down beats up; tied → higher latency wins" — matches the backfill
 *  decimation query's ORDER BY clause. */
function isWorse(a: ChartDataPoint, b: ChartDataPoint): boolean {
  const aDown = a[2] === 0;
  const bDown = b[2] === 0;
  if (aDown !== bDown) return aDown && !bDown;
  return a[1] > b[1];
}

/** Insert a point into a per-tier sorted array, applying worst-of-bucket if
 *  another point already lives in the same bucket. Array stays sorted by ts
 *  ASC. Points almost always arrive newest-last, so search from the end. */
export function mergeIntoBucket(arr: ChartDataPoint[], pt: ChartDataPoint, bucketWidthMs: number): void {
  const newBucket = Math.floor(pt[0] / bucketWidthMs);
  for (let i = arr.length - 1; i >= 0; i--) {
    const b = Math.floor(arr[i][0] / bucketWidthMs);
    if (b === newBucket) {
      if (isWorse(pt, arr[i])) arr[i] = pt;
      return;
    }
    if (b < newBucket) {
      arr.splice(i + 1, 0, pt);
      return;
    }
  }
  arr.unshift(pt);
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

// ── Pure state transitions (exported for tests) ──────────────────────────────

export function emptyRecent(hour: number, coldGen: number, primaryUrls: Record<string, string>): RecentRollups {
  return { hour, coldGen, primaryUrls, chart: {}, uptime: {} };
}

/** Which rollups a tick's results still need adding to. A rollup just rebuilt
 *  from D1 already holds them, since the tick inserts into D1 first. */
export interface Pending {
  chart: boolean;
  uptime: boolean;
}

/** Add one tick's results to the recent blob. */
export function accumulateRecent(
  recent: RecentRollups,
  results: CheckResult[],
  pending: Pending = { chart: true, uptime: true },
): void {
  for (const r of results) {
    if (pending.uptime) {
      const bucket = ((recent.uptime[r.service] ??= {})[String(hourBucket(r.timestamp))] ??= { ups: 0, totals: 0 });
      bucket.totals++;
      if (r.status === 'up') bucket.ups++;
    }

    if (!isPrimaryType(r.type)) continue;
    const primaryUrl = (recent.primaryUrls[r.service] ??= r.url);
    if (!pending.chart || r.url !== primaryUrl) continue;
    mergeIntoBucket((recent.chart[r.service] ??= []), encodePoint(r), MIN_MS);
  }
}

/** Fold the recent chart points into the cold tiers, then promote by age. */
export function foldChart(cold: ChartTieredState, recent: RecentRollups, now: number): void {
  for (const [service, points] of Object.entries(recent.chart)) {
    const svc = (cold[service] ??= {
      primaryUrl: recent.primaryUrls[service],
      t1: [],
      t10: [],
      t30: [],
      t120: [],
    });
    for (const pt of points) mergeIntoBucket(svc.t1, pt, MIN_MS);
  }
  for (const svc of Object.values(cold)) promoteTiers(svc, now);
}

/** Fold the recent uptime counters into the cold buckets; drop buckets >30d. */
export function foldUptime(cold: UptimeBucketsState, recent: RecentRollups, now: number): void {
  for (const [service, buckets] of Object.entries(recent.uptime)) {
    const svc = (cold[service] ??= {});
    for (const [hb, { ups, totals }] of Object.entries(buckets)) {
      const b = (svc[hb] ??= { ups: 0, totals: 0 });
      b.ups += ups;
      b.totals += totals;
    }
  }
  const cutoff = hourBucket(now) - 30 * 24;
  for (const svc of Object.values(cold)) {
    for (const hb of Object.keys(svc)) {
      if (Number(hb) < cutoff) delete svc[hb];
    }
  }
}

// ── Write path ───────────────────────────────────────────────────────────────

/** Record one cron tick's results. Every tick rewrites only the small recent
 *  blob; the first tick of a new hour first folds the finished hour into the
 *  cold blobs. A cold blob that is missing is rebuilt from D1 at fold time. */
export async function recordTickRollups(
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  results: CheckResult[],
  now: number,
): Promise<void> {
  if (!kv) return;
  const raw = await kv.get(KV_RECENT_KEY);
  let recent = raw === null ? null : (JSON.parse(raw) as RecentRollups);
  const hour = hourBucket(now);
  let pending: Pending = { chart: true, uptime: true };
  if (recent === null || recent.hour !== hour) {
    ({ recent, pending } = await foldIntoCold(kv, db, recent, now));
  } else if (results.length === 0) {
    return;
  }
  accumulateRecent(recent, results, pending);
  await kv.put(KV_RECENT_KEY, JSON.stringify(recent));
}

async function foldIntoCold(
  kv: KVNamespace,
  db: D1Database | undefined,
  recent: RecentRollups | null,
  now: number,
): Promise<{ recent: RecentRollups; pending: Pending }> {
  const [chartRaw, uptimeRaw] = await Promise.all([kv.get(KV_CHART_TIERED_KEY), kv.get(KV_UPTIME_BUCKETS_KEY)]);
  const finished = recent ?? emptyRecent(hourBucket(now), 0, {});

  // A missing cold blob is rebuilt from D1, which already holds every check
  // the recent blob counted, and this tick's too. So neither is added on top.
  let chart: ChartTieredState;
  if (chartRaw === null) {
    if (!db) throw new Error('rollups: cold chart blob is missing and there is no D1 to rebuild it from');
    console.log('Rebuilding cold chart rollup from D1...');
    chart = await buildChartFromDB(db, now);
  } else {
    chart = JSON.parse(chartRaw) as ChartTieredState;
    foldChart(chart, finished, now);
  }

  let uptime: UptimeBucketsState;
  if (uptimeRaw === null) {
    if (!db) throw new Error('rollups: cold uptime blob is missing and there is no D1 to rebuild it from');
    console.log('Rebuilding cold uptime rollup from D1...');
    uptime = await buildUptimeFromDB(db, now);
  } else {
    uptime = JSON.parse(uptimeRaw) as UptimeBucketsState;
    foldUptime(uptime, finished, now);
  }

  await Promise.all([
    kv.put(KV_CHART_TIERED_KEY, JSON.stringify(chart)),
    kv.put(KV_UPTIME_BUCKETS_KEY, JSON.stringify(uptime)),
  ]);

  const primaryUrls: Record<string, string> = {};
  for (const [service, svc] of Object.entries(chart)) primaryUrls[service] = svc.primaryUrl;
  return {
    recent: emptyRecent(hourBucket(now), now, primaryUrls),
    pending: { chart: chartRaw !== null, uptime: uptimeRaw !== null },
  };
}

// ── Read path ────────────────────────────────────────────────────────────────

async function getRecent(kv: KVNamespace): Promise<RecentRollups | null> {
  const raw = await kv.get(KV_RECENT_KEY);
  return raw === null ? null : (JSON.parse(raw) as RecentRollups);
}

/** Chart data for all services: cold tiers (memoized until the next fold) plus
 *  this hour's points. Returns {} before the first tick has written anything. */
export async function getChartData(kv: KVNamespace | undefined, memo: GenerationMemo): Promise<ChartData> {
  if (!kv) return {};
  const recent = await getRecent(kv);
  const cold = await memo('chart-cold', recent?.coldGen, async () => {
    const raw = await kv.get(KV_CHART_TIERED_KEY);
    if (raw === null) return {};
    const out: ChartData = {};
    for (const [service, tiers] of Object.entries(JSON.parse(raw) as ChartTieredState)) {
      out[service] = [...tiers.t120, ...tiers.t30, ...tiers.t10, ...tiers.t1];
    }
    return out;
  });
  if (!recent) return cold;
  const out: ChartData = { ...cold };
  for (const [service, points] of Object.entries(recent.chart)) {
    out[service] = (cold[service] ?? []).concat(points);
  }
  return out;
}

interface UptimeTotals {
  up24h: number;
  total24h: number;
  up7d: number;
  total7d: number;
  up30d: number;
  total30d: number;
}

function addToTotals(t: UptimeTotals, buckets: Record<string, UptimeHourBucket>, nowHb: number): void {
  for (const [hbStr, { ups, totals }] of Object.entries(buckets)) {
    const hb = Number(hbStr);
    if (hb >= nowHb - 30 * 24) {
      t.up30d += ups;
      t.total30d += totals;
    }
    if (hb >= nowHb - 7 * 24) {
      t.up7d += ups;
      t.total7d += totals;
    }
    if (hb >= nowHb - 24) {
      t.up24h += ups;
      t.total24h += totals;
    }
  }
}

const zeroTotals = (): UptimeTotals => ({ up24h: 0, total24h: 0, up7d: 0, total7d: 0, up30d: 0, total30d: 0 });

/** Sum both blobs into 24h/7d/30d windows ending at `nowHb`. Pure. */
export function combineUptime(
  coldTotals: Record<string, UptimeTotals>,
  recent: RecentRollups | null,
  nowHb: number,
): Record<string, UptimeByPeriod> {
  const totals: Record<string, UptimeTotals> = {};
  for (const [service, t] of Object.entries(coldTotals)) totals[service] = { ...t };
  for (const [service, buckets] of Object.entries(recent?.uptime ?? {})) {
    addToTotals((totals[service] ??= zeroTotals()), buckets, nowHb);
  }
  const pct = (up: number, total: number) => (total > 0 ? (up / total) * 100 : null);
  const stats: Record<string, UptimeByPeriod> = {};
  for (const [service, t] of Object.entries(totals)) {
    stats[service] = {
      uptime24h: pct(t.up24h, t.total24h),
      uptime7d: pct(t.up7d, t.total7d),
      uptime30d: pct(t.up30d, t.total30d),
      checkCount24h: t.total24h,
      checkCount7d: t.total7d,
      checkCount30d: t.total30d,
    };
  }
  return stats;
}

/** Uptime percentages for 24h / 7d / 30d. The cold sums are memoized until the
 *  next fold, which is also when their window boundaries move. */
export async function getMultiPeriodUptime(
  kv: KVNamespace | undefined,
  memo: GenerationMemo,
): Promise<Record<string, UptimeByPeriod>> {
  if (!kv) return {};
  const recent = await getRecent(kv);
  const nowHb = hourBucket(Date.now());
  const coldTotals = await memo('uptime-cold', recent?.coldGen, async () => {
    const raw = await kv.get(KV_UPTIME_BUCKETS_KEY);
    const out: Record<string, UptimeTotals> = {};
    if (raw === null) return out;
    for (const [service, buckets] of Object.entries(JSON.parse(raw) as UptimeBucketsState)) {
      addToTotals((out[service] = zeroTotals()), buckets, nowHb);
    }
    return out;
  });
  return combineUptime(coldTotals, recent, nowHb);
}

// ── Rebuild from D1 (only when a cold blob is missing) ───────────────────────

async function buildUptimeFromDB(db: D1Database, now: number): Promise<UptimeBucketsState> {
  const results = await db
    .prepare(
      `SELECT service,
              CAST(timestamp / ${HOUR_MS} AS INTEGER) AS hb,
              COUNT(*) AS totals,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS ups
       FROM (
${unionChecks(t => `SELECT service, timestamp, status FROM ${t} WHERE ${checksSince(t, '?1')}`)}
       )
       GROUP BY service, hb`,
    )
    .bind(now - HISTORY_RETENTION_MS)
    .all<{ service: string; hb: number; totals: number; ups: number }>();

  const state: UptimeBucketsState = {};
  for (const r of results.results) {
    (state[r.service] ??= {})[String(r.hb)] = { ups: r.ups, totals: r.totals };
  }
  return state;
}

/** Runs the tiered decimation in SQL. Reads ~one chart's worth of D1 rows. */
async function buildChartFromDB(db: D1Database, now: number): Promise<ChartTieredState> {
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
      FROM (
${unionChecks(
  t => `SELECT service, url, timestamp, latency, status, code, error FROM ${t}
        WHERE ${checksSince(t, '?4')} AND type IN ('https', 'secret')`,
)}
      )
    )
    WHERE rn = 1
    ORDER BY service, url, timestamp ASC
  `,
    )
    .bind(now - T1_MAX_AGE_MS, now - T10_MAX_AGE_MS, now - T30_MAX_AGE_MS, now - HISTORY_RETENTION_MS)
    .all<{
      service: string;
      url: string;
      timestamp: number;
      latency: number;
      status: string;
      code: number | null;
      error: string | null;
    }>();

  const state: ChartTieredState = {};
  for (const r of results.results) {
    const svc = (state[r.service] ??= { primaryUrl: r.url, t1: [], t10: [], t30: [], t120: [] });
    if (r.url !== svc.primaryUrl) continue;
    const pt: ChartDataPoint = [r.timestamp, r.latency, r.status === 'up' ? 1 : 0];
    if (r.code) pt.push(r.code);
    if (r.error) {
      if (pt.length === 3) pt.push(0);
      pt.push(r.error);
    }
    const age = now - r.timestamp;
    if (age < T1_MAX_AGE_MS) svc.t1.push(pt);
    else if (age < T10_MAX_AGE_MS) svc.t10.push(pt);
    else if (age < T30_MAX_AGE_MS) svc.t30.push(pt);
    else svc.t120.push(pt);
  }
  return state;
}
