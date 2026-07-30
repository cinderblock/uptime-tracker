/** Storage layer for the cost monitor. Every query is bounded by hour_bucket
 *  via the idx_usage_hour index — there must be NO full-table scans here
 *  (the same mistake that caused the April 2026 D1 cost incident). */

const HOUR_MS = 3_600_000;

export interface UsageRow {
  provider: string;
  resource: string;
  model?: string | null;
  source: 'graphql' | 'push' | 'cloud-billing';
  tag?: string | null;
  countUnits: bigint;
  costMicros: bigint;
  timestamp: number; // ms epoch
}

export interface ProviderTotal {
  provider: string;
  costMicros: bigint;
}

export interface HourSample {
  hourBucket: number; // floor(ms / 3_600_000)
  provider: string;
  costMicros: bigint;
}

export function hourBucket(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS);
}

/** Hour bucket of 00:00 UTC on the 1st of the calendar month containing `nowMs`.
 *  Used to define "this billing period" — Cloudflare and most providers bill
 *  on calendar-month UTC boundaries. */
export function monthStartHourBucket(nowMs: number): number {
  const d = new Date(nowMs);
  return hourBucket(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Hour bucket of 00:00 UTC on the 1st of the previous calendar month.
 *  Pair with `monthStartHourBucket(now)` as an exclusive upper bound to get
 *  exactly last month's window. */
export function prevMonthStartHourBucket(nowMs: number): number {
  const d = new Date(nowMs);
  return hourBucket(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

/** Insert a usage sample. Used by both pollers and the /api/usage endpoint. */
export async function recordUsage(db: D1Database | undefined, row: UsageRow): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO usage_log (provider, resource, model, source, tag, count_units, cost_micros, hour_bucket, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.provider,
      row.resource,
      row.model ?? null,
      row.source,
      row.tag ?? null,
      row.countUnits.toString(),
      row.costMicros.toString(),
      hourBucket(row.timestamp),
      row.timestamp,
    )
    .run();
}

/** Batch-insert multiple usage samples in one D1 transaction. */
export async function recordUsageBatch(db: D1Database | undefined, rows: UsageRow[]): Promise<void> {
  if (!db || rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO usage_log (provider, resource, model, source, tag, count_units, cost_micros, hour_bucket, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    rows.map(r =>
      stmt.bind(
        r.provider,
        r.resource,
        r.model ?? null,
        r.source,
        r.tag ?? null,
        r.countUnits.toString(),
        r.costMicros.toString(),
        hourBucket(r.timestamp),
        r.timestamp,
      ),
    ),
  );
}

/** Sum cost_micros over [sinceHourBucket, untilHourBucket), grouped by provider.
 *  `untilHourBucket` is exclusive; omit for an open-ended window (current usage).
 *  Both bounds use the idx_usage_hour index — no full-table scans. */
export async function getCostByProvider(
  db: D1Database | undefined,
  sinceHourBucket: number,
  untilHourBucket?: number,
): Promise<ProviderTotal[]> {
  if (!db) return [];
  const stmt =
    untilHourBucket === undefined
      ? db
          .prepare(
            `SELECT provider, SUM(cost_micros) AS total_micros
             FROM usage_log
             WHERE hour_bucket >= ?
             GROUP BY provider`,
          )
          .bind(sinceHourBucket)
      : db
          .prepare(
            `SELECT provider, SUM(cost_micros) AS total_micros
             FROM usage_log
             WHERE hour_bucket >= ? AND hour_bucket < ?
             GROUP BY provider`,
          )
          .bind(sinceHourBucket, untilHourBucket);
  const result = await stmt.all<{ provider: string; total_micros: number | string }>();
  return result.results.map(r => ({
    provider: r.provider,
    costMicros: BigInt(r.total_micros),
  }));
}

/** Get hourly cost samples per provider for the dashboard sparkline.
 *  Bounded by sinceHourBucket via idx_usage_hour. */
export async function getHourlySamples(db: D1Database | undefined, sinceHourBucket: number): Promise<HourSample[]> {
  if (!db) return [];
  const result = await db
    .prepare(
      `SELECT hour_bucket, provider, SUM(cost_micros) AS total_micros
       FROM usage_log
       WHERE hour_bucket >= ?
       GROUP BY hour_bucket, provider
       ORDER BY hour_bucket ASC`,
    )
    .bind(sinceHourBucket)
    .all<{ hour_bucket: number; provider: string; total_micros: number | string }>();
  return result.results.map(r => ({
    hourBucket: r.hour_bucket,
    provider: r.provider,
    costMicros: BigInt(r.total_micros),
  }));
}

/** Cleanup: drop usage_log rows older than 90 days. Called from the existing
 *  hourly cleanup gate. */
export async function cleanupUsageLog(db: D1Database | undefined, retentionDays = 90): Promise<number> {
  if (!db) return 0;
  const cutoffHourBucket = hourBucket(Date.now() - retentionDays * 24 * HOUR_MS);
  const result = await db.prepare(`DELETE FROM usage_log WHERE hour_bucket < ?`).bind(cutoffHourBucket).run();
  return result.meta.changes ?? 0;
}

// ============================================
// Thresholds (KV-backed config)
// ============================================
//
// Threshold config + dedup state live in KV blobs rather than D1. Config is
// pure key/value with no aggregation, edits are rare, and the worker reads
// once per cron tick — KV fits this shape better than a D1 table. State is
// scoped to the same blob namespace so cost-monitor concerns stay out of the
// existing `notification_state` D1 table.

const KV_THRESHOLDS_KEY = 'cost:thresholds';
const KV_THRESHOLD_STATE_KEY = 'cost:state';

export interface UsageThreshold {
  key: string;
  thresholdCents: number;
  windowSeconds: number;
  enabled: boolean;
  urgency: string | null;
}

/** Defaults seeded on first read. Edit by `kv.put('cost:thresholds', ...)`
 *  with the modified JSON; deleting the key resets to these on next read. */
const DEFAULT_THRESHOLDS: UsageThreshold[] = [
  { key: 'usage:cloudflare:hourly', thresholdCents: 50, windowSeconds: 3600, enabled: true, urgency: null },
  { key: 'usage:cloudflare:daily', thresholdCents: 500, windowSeconds: 86400, enabled: true, urgency: null },
  { key: 'usage:gemini:hourly', thresholdCents: 100, windowSeconds: 3600, enabled: true, urgency: null },
  { key: 'usage:gemini:daily', thresholdCents: 1000, windowSeconds: 86400, enabled: true, urgency: null },
  { key: 'usage:total:daily', thresholdCents: 1500, windowSeconds: 86400, enabled: true, urgency: null },
];

/** Read thresholds from KV; on miss or corruption, self-seed defaults.
 *  Concurrent first-reads are safe — KV is last-write-wins and both writers
 *  send identical content. */
export async function getThresholds(kv: KVNamespace | undefined): Promise<UsageThreshold[]> {
  if (!kv) return [];
  const raw = await kv.get(KV_THRESHOLDS_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as UsageThreshold[];
    } catch {
      console.warn(`Cost monitor: ${KV_THRESHOLDS_KEY} parse failed, re-seeding defaults`);
    }
  }
  await kv.put(KV_THRESHOLDS_KEY, JSON.stringify(DEFAULT_THRESHOLDS));
  return DEFAULT_THRESHOLDS;
}

export async function setThresholds(kv: KVNamespace | undefined, thresholds: UsageThreshold[]): Promise<void> {
  if (!kv) return;
  await kv.put(KV_THRESHOLDS_KEY, JSON.stringify(thresholds));
}

/** Per-threshold dedup state: which window the alert last fired in. A new
 *  window allows a new fire if usage is still above the threshold. */
export interface ThresholdStateEntry {
  lastFiredWindowId: number;
  lastFiredCostCents: number;
}

export type ThresholdState = Record<string, ThresholdStateEntry>;

export async function getThresholdState(kv: KVNamespace | undefined): Promise<ThresholdState> {
  if (!kv) return {};
  const raw = await kv.get(KV_THRESHOLD_STATE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ThresholdState;
  } catch {
    console.warn(`Cost monitor: ${KV_THRESHOLD_STATE_KEY} parse failed, resetting`);
    return {};
  }
}

export async function setThresholdState(kv: KVNamespace | undefined, state: ThresholdState): Promise<void> {
  if (!kv) return;
  await kv.put(KV_THRESHOLD_STATE_KEY, JSON.stringify(state));
}

// ============================================
// Pricing override (KV)
// ============================================

const KV_PRICING_OVERRIDE_KEY = 'pricing:override';

export async function getPricingOverride(
  kv: KVNamespace | undefined,
): Promise<import('./pricing').PricingOverride | null> {
  if (!kv) return null;
  const raw = await kv.get(KV_PRICING_OVERRIDE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as import('./pricing').PricingOverride;
}
