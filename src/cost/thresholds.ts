/** Threshold checker. Runs each cron tick; cheap because every D1 query is
 *  bounded by hour_bucket via idx_usage_hour, and config + dedup state live
 *  in KV (one read + at-most-one write per tick — no D1 hits for state).
 *
 *  Dedup: each threshold's `lastFiredWindowId` records the window it last
 *  alerted in. A new window allows a new fire if usage is still above the
 *  threshold; same window = no re-fire. */

import type { PushUrgency } from '../types';
import { getThresholds, getThresholdState, setThresholdState, type ThresholdState } from './store';

export interface ThresholdAlert {
  key: string;
  scope: string; // 'cloudflare' | 'gemini' | 'total' | future providers
  windowSeconds: number;
  windowId: number; // floor(now / windowMs)
  thresholdCents: number;
  actualCostMicros: bigint;
  urgency: PushUrgency | null;
}

/** Parse the provider-scope from a threshold key like 'usage:cloudflare:hourly'.
 *  Returns 'total' for keys that should sum across all providers. */
function scopeOf(key: string): string {
  const parts = key.split(':');
  return parts[1] ?? 'total';
}

async function sumCostMicros(db: D1Database, sinceHourBucket: number, provider: string | null): Promise<bigint> {
  if (provider) {
    const row = await db
      .prepare(
        `SELECT SUM(cost_micros) AS total FROM usage_log
         WHERE hour_bucket >= ? AND provider = ?`,
      )
      .bind(sinceHourBucket, provider)
      .first<{ total: number | string | null }>();
    return BigInt(row?.total ?? 0);
  }
  const row = await db
    .prepare(`SELECT SUM(cost_micros) AS total FROM usage_log WHERE hour_bucket >= ?`)
    .bind(sinceHourBucket)
    .first<{ total: number | string | null }>();
  return BigInt(row?.total ?? 0);
}

/** Build the list of threshold alerts that should fire right now.
 *  Doesn't send notifications or mutate state — that's the caller's job
 *  (so a failed-to-send alert isn't marked as fired). */
export async function checkThresholds(
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  now = Date.now(),
): Promise<ThresholdAlert[]> {
  if (!kv || !db) return [];
  const thresholds = await getThresholds(kv);
  if (thresholds.length === 0) return [];
  const state = await getThresholdState(kv);

  const alerts: ThresholdAlert[] = [];
  for (const t of thresholds) {
    if (!t.enabled) continue;

    const windowMs = t.windowSeconds * 1000;
    const windowId = Math.floor(now / windowMs);
    const sinceTimestamp = windowId * windowMs;
    const sinceHourBucket = Math.floor(sinceTimestamp / 3_600_000);

    const scope = scopeOf(t.key);
    const provider = scope === 'total' ? null : scope;

    const totalCostMicros = await sumCostMicros(db, sinceHourBucket, provider);
    // cents = micros / 10_000 (micros = $·10⁻⁶, cents = $·10⁻²)
    const totalCostCents = Number(totalCostMicros / 10_000n);
    if (totalCostCents < t.thresholdCents) continue;

    if (state[t.key]?.lastFiredWindowId === windowId) continue;

    alerts.push({
      key: t.key,
      scope,
      windowSeconds: t.windowSeconds,
      windowId,
      thresholdCents: t.thresholdCents,
      actualCostMicros: totalCostMicros,
      urgency: t.urgency as PushUrgency | null,
    });
  }
  return alerts;
}

/** Format an alert's notification title + body. */
export function alertNotificationContent(alert: ThresholdAlert): { title: string; body: string } {
  const windowLabel =
    alert.windowSeconds === 3600
      ? 'this hour'
      : alert.windowSeconds === 86400
        ? 'last 24h'
        : `last ${Math.round(alert.windowSeconds / 3600)}h`;
  const scopeLabel = alert.scope === 'total' ? 'Total' : capitalize(alert.scope);
  const actualUsd = (Number(alert.actualCostMicros) / 1_000_000).toFixed(2);
  const thresholdUsd = (alert.thresholdCents / 100).toFixed(2);
  return {
    title: `${scopeLabel} cost > $${thresholdUsd} ${windowLabel}`,
    body: `Actual: $${actualUsd}. Threshold: $${thresholdUsd}.`,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface ThresholdStatus {
  key: string;
  scope: string;
  windowSeconds: number;
  thresholdCents: number;
  currentCostMicros: bigint;
  /** 0..1+, clamped to 0 for display but unclamped for "over" colors. */
  fractionUsed: number;
  enabled: boolean;
}

/** Snapshot of every threshold's current spend for the dashboard panel.
 *  Same index-bounded D1 SUM as checkThresholds but returns all rows
 *  including not-yet-fired ones. */
export async function getThresholdStatus(
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  now = Date.now(),
): Promise<ThresholdStatus[]> {
  if (!kv || !db) return [];
  const thresholds = await getThresholds(kv);
  const out: ThresholdStatus[] = [];
  for (const t of thresholds) {
    const windowMs = t.windowSeconds * 1000;
    const windowId = Math.floor(now / windowMs);
    const sinceHourBucket = Math.floor((windowId * windowMs) / 3_600_000);
    const scope = scopeOf(t.key);
    const provider = scope === 'total' ? null : scope;
    const currentCostMicros = await sumCostMicros(db, sinceHourBucket, provider);
    const currentCents = Number(currentCostMicros / 10_000n);
    out.push({
      key: t.key,
      scope,
      windowSeconds: t.windowSeconds,
      thresholdCents: t.thresholdCents,
      currentCostMicros,
      fractionUsed: t.thresholdCents > 0 ? currentCents / t.thresholdCents : 0,
      enabled: t.enabled,
    });
  }
  return out;
}

/** Mark a batch of alerts as fired so they don't re-fire until their window
 *  rolls over. One KV write per cron tick regardless of alert count. */
export async function markThresholdsFired(kv: KVNamespace | undefined, alerts: ThresholdAlert[]): Promise<void> {
  if (!kv || alerts.length === 0) return;
  const state: ThresholdState = await getThresholdState(kv);
  for (const alert of alerts) {
    state[alert.key] = {
      lastFiredWindowId: alert.windowId,
      lastFiredCostCents: Number(alert.actualCostMicros / 10_000n),
    };
  }
  await setThresholdState(kv, state);
}
