/**
 * Plan profiles — the knob bundle that makes this run on either Cloudflare
 * plan.
 *
 * These are not two sets of numbers for one code path. The free plan's 10 ms
 * CPU-per-invocation ceiling (not raisable — `limits.cpu_ms` is paid-only)
 * cannot absorb the paid profile's megabyte-scale JSON round-trip every tick,
 * so `aggregateStore` genuinely switches where rolled-up history lives.
 *
 * The resource picture inverts between plans, which is why one setting can't
 * serve both:
 *
 *   Free   KV: 1,000 writes/day     D1: 100,000 rows written/day, 5M read/day
 *          → KV is write-starved; D1 has ~100x the write headroom.
 *          → Keep aggregates in D1; write KV only on real state changes.
 *
 *   Paid   KV: 1M writes/month      D1: billed per row *scanned* on read
 *          → D1 reads are the thing to avoid on the request path.
 *          → Keep aggregates in precomputed KV blobs; one read serves a page.
 *
 * Limits verified against developers.cloudflare.com, 2026-07-28.
 */

import type { Env } from './types';

export type PlanTier = 'free' | 'paid';

export interface PlanProfile {
  tier: PlanTier;
  /** Cron interval in minutes — must match [triggers] in wrangler.toml. */
  cronIntervalMinutes: number;
  /** Hard cap on outbound service-check fetches launched per tick.
   *  Free must leave room under the 50-subrequest ceiling for GitHub polling
   *  and push delivery. */
  checkBudget: number;
  /** Max GitHub API calls per tick (workflow badges + timeline lanes). */
  githubBudget: number;
  /** Concurrency pool default: "max periodMs start increment".
   *  Free plans get 6 simultaneous outgoing connections, so ramping past that
   *  buys nothing. */
  checkConcurrency: string;
  /** Where rolled-up chart/uptime aggregates live. See the note above. */
  aggregateStore: 'kv' | 'd1';
  /** Days of per-check history retained in D1. */
  historyRetentionDays: number;
  /** Run D1 cleanup every N ticks. */
  cleanupEveryTicks: number;
  /** Evaluate cost-monitor thresholds every N ticks (each pass costs D1 reads). */
  costCheckEveryTicks: number;
  /** Poll the Cloudflare Analytics API every N ticks. */
  costPollEveryTicks: number;
  /** Dashboard auto-refresh interval, milliseconds. */
  clientPollMs: number;
  /** Full (chart-refreshing) dashboard poll interval, milliseconds. */
  clientFullPollMs: number;
}

/** Per-tier defaults. `cronIntervalMinutes` is what each profile assumes. */
const PROFILES: Record<PlanTier, PlanProfile> = {
  paid: {
    tier: 'paid',
    cronIntervalMinutes: 1,
    checkBudget: 500,
    githubBudget: 30,
    checkConcurrency: '25',
    aggregateStore: 'kv',
    historyRetentionDays: 30,
    cleanupEveryTicks: 5,
    costCheckEveryTicks: 1,
    costPollEveryTicks: 60,
    clientPollMs: 30_000,
    clientFullPollMs: 300_000,
  },
  free: {
    tier: 'free',
    cronIntervalMinutes: 5,
    // 50 subrequests/invocation is the hard ceiling. Reserve ~20 for GitHub
    // polling, push delivery, and check retries.
    checkBudget: 30,
    githubBudget: 5,
    // 6 simultaneous outgoing connections on free — ramping beyond that is a no-op.
    checkConcurrency: '6',
    aggregateStore: 'd1',
    // 500 MB per free database; shorter retention also keeps scans small, and
    // D1 bills reads by rows *scanned*.
    historyRetentionDays: 7,
    cleanupEveryTicks: 12,
    costCheckEveryTicks: 12,
    costPollEveryTicks: 12,
    clientPollMs: 60_000,
    clientFullPollMs: 600_000,
  },
};

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Resolve the active profile from the environment.
 *
 * Throws on an unrecognised PLAN rather than falling back to a default — a
 * typo silently running the wrong storage path would blow a free account's
 * quota within a day.
 */
export function resolvePlan(env: Env): PlanProfile {
  const raw = (env.PLAN ?? 'paid').trim().toLowerCase();
  if (raw !== 'free' && raw !== 'paid') {
    throw new Error(`PLAN must be "free" or "paid", got ${JSON.stringify(env.PLAN)}`);
  }

  const base = PROFILES[raw as PlanTier];
  return {
    ...base,
    cronIntervalMinutes:
      parsePositiveInt(env.CRON_INTERVAL_MINUTES, 'CRON_INTERVAL_MINUTES') ?? base.cronIntervalMinutes,
    checkBudget: parsePositiveInt(env.CHECK_BUDGET, 'CHECK_BUDGET') ?? base.checkBudget,
    checkConcurrency: env.CHECK_CONCURRENCY ?? base.checkConcurrency,
    historyRetentionDays:
      parsePositiveInt(env.HISTORY_RETENTION_DAYS, 'HISTORY_RETENTION_DAYS') ?? base.historyRetentionDays,
  };
}

/**
 * TTL for the DDNS hot-path cache.
 *
 * This must outlive the gap between cron ticks. The KV blob is the only one
 * with an expiry, and when it lapses every dashboard request falls back to a
 * 200-row D1 query — which is exactly the read-path cost the paid profile
 * exists to avoid. Three ticks of slack absorbs a missed run.
 *
 * KV rejects TTLs under 60 seconds.
 */
export function ddnsCacheTtlSeconds(plan: PlanProfile): number {
  return Math.max(60, plan.cronIntervalMinutes * 60 * 3);
}

/** Should this tick do work that only runs every N ticks? */
export function isNthTick(minuteOfDay: number, plan: PlanProfile, everyTicks: number): boolean {
  if (everyTicks <= 1) return true;
  const tickIndex = Math.floor(minuteOfDay / plan.cronIntervalMinutes);
  return tickIndex % everyTicks === 0;
}
