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
import type { GenerationMemo } from './read-memo';
import {
  getChartData as getKvChart,
  getMultiPeriodUptime as getKvUptime,
  recordTickRollups,
  type ChartData,
  type UptimeByPeriod,
} from './rollups';
import { blobGet, blobPut, getChartFromRollup, getUptimeFromRollup, rollUpHourly } from './storage-free';

// ── Plan dispatch ────────────────────────────────────────────────────────────
// Every public function below that touches derived state takes the resolved
// `PlanProfile` as its first argument and branches on `plan.aggregateStore`.
//
//   'kv' (paid) — precomputed KV blobs; D1 is never read from a request
//                 handler. Chart + uptime rollups live in src/rollups.ts.
//   'd1' (free) — src/storage-free.ts. Small blobs move to the `blobs` table;
//                 the large chart/uptime blobs are not maintained at all and
//                 their data is derived from `uptime_hourly` on read.
//
// The paid path runs the ops deployment: change it deliberately, and measure.

/** True when the caller is on the free profile's D1 storage path. */
function useD1(plan: PlanProfile): boolean {
  return plan.aggregateStore === 'd1';
}

// ── KV hot-path cache ────────────────────────────────────────────────────────
// Dashboard status and last-checked times are batched into a single KV key
// to minimize writes (1 write/cron cycle instead of 2).

const KV_HOT_KEY = 'cache:hot';
const KV_DDNS_KEY = 'cache:ddns';

// Durable, incrementally-maintained derived state. No TTL. The chart and uptime
// rollups live in rollups.ts.
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

// ── Chart + uptime rollups ───────────────────────────────────────────────────
// Paid: rollups.ts (KV, hot/cold). Free: storage-free.ts (D1 `uptime_hourly`).

/** Get uptime stats for 24h / 7d / 30d. */
export async function getMultiPeriodUptime(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  memo: GenerationMemo,
): Promise<Record<string, UptimeByPeriod>> {
  if (useD1(plan)) return getUptimeFromRollup(db, plan.historyRetentionDays);
  return getKvUptime(kv, memo);
}

/** Chart data for every service's primary check. */
export async function getChartData(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  memo: GenerationMemo,
): Promise<ChartData> {
  if (useD1(plan)) return getChartFromRollup(db, plan.historyRetentionDays);
  return getKvChart(kv, memo);
}

/** Add one tick's results to the rollups. Free: `rollUpHourly` instead.
 *  Call after `addToHistory` (a missing cold blob is rebuilt from D1 and must
 *  include this tick) and before `saveCurrentStatus` (its lastUpdate keys the
 *  readers' memo). */
export async function recordRollups(
  plan: PlanProfile,
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  results: CheckResult[],
  now: number,
): Promise<void> {
  if (useD1(plan)) return rollUpHourly(db, results, plan.historyRetentionDays);
  return recordTickRollups(kv, db, results, now);
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
  let raw = d1 ? await blobGet(db, KV_TRANSITIONS_KEY) : ((await kv?.get(KV_TRANSITIONS_KEY)) ?? null);
  let changed = false;

  // Plan switch carry-over. The timeline is forward-only and has no `checks`
  // table to rebuild from — unlike charts and uptime, which self-backfill — so
  // switching plans would otherwise silently reset it to empty. If the active
  // store has nothing, adopt whatever the other store holds and mark dirty so
  // it lands in the new home this tick. Runs once: after the carry the active
  // store is populated and this branch is never taken again.
  if (raw === null) {
    const carried = d1 ? ((await kv?.get(KV_TRANSITIONS_KEY)) ?? null) : await blobGet(db, KV_TRANSITIONS_KEY);
    if (carried !== null) {
      console.log(`Carrying transition timeline into ${d1 ? 'D1 blobs' : 'KV'} after plan switch`);
      raw = carried;
      changed = true;
    }
  }

  const state: TransitionsState = raw ? (JSON.parse(raw) as TransitionsState) : {};

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
/** Most recent failures, newest first.
 *
 *  Bounded two ways on purpose: the composite (status, timestamp) index from
 *  migration 0010 keeps the scan proportional to `limit` rather than to table
 *  size, and `sinceDays` caps it even if the planner picks a different index.
 *  Without either, a healthy deployment scans its whole retention window to
 *  render an empty errors page — D1 bills rows scanned. */
export async function getRecentErrors(
  db: D1Database | undefined,
  service?: string,
  limit = 100,
  sinceDays = 30,
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

  const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const query = service
    ? `SELECT service, url, type, code, error, latency, source, timestamp
       FROM checks WHERE status = 'down' AND timestamp > ? AND service = ?
       ORDER BY timestamp DESC LIMIT ?`
    : `SELECT service, url, type, code, error, latency, source, timestamp
       FROM checks WHERE status = 'down' AND timestamp > ?
       ORDER BY timestamp DESC LIMIT ?`;

  const stmt = db.prepare(query);
  const bound = service ? stmt.bind(since, service, limit) : stmt.bind(since, limit);

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

const DEFAULT_NOTIFICATION_STATE: NotificationState = {
  consecutive_down: 0,
  notified_down: 0,
};

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
