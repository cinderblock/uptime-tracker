import { describe, expect, test } from 'bun:test';
import { ddnsCacheTtlSeconds, isNthTick, resolvePlan } from '../src/plan';
import type { Env } from '../src/types';

const env = (o: Partial<Env>) => o as Env;

describe('resolvePlan', () => {
  test('defaults to paid when PLAN is unset', () => {
    expect(resolvePlan(env({})).tier).toBe('paid');
  });

  test('accepts either tier, case- and whitespace-insensitively', () => {
    expect(resolvePlan(env({ PLAN: ' FREE ' })).tier).toBe('free');
    expect(resolvePlan(env({ PLAN: 'Paid' })).tier).toBe('paid');
  });

  // A typo silently running the paid storage path would exhaust a free
  // account's KV write budget within a day, so this must throw rather than
  // fall back to a default.
  test('throws on an unrecognised PLAN instead of defaulting', () => {
    expect(() => resolvePlan(env({ PLAN: 'fre' }))).toThrow(/PLAN must be/);
    expect(() => resolvePlan(env({ PLAN: '' }))).toThrow(/PLAN must be/);
  });

  test('the two profiles differ in the ways that matter', () => {
    const free = resolvePlan(env({ PLAN: 'free' }));
    const paid = resolvePlan(env({ PLAN: 'paid' }));
    expect(free.aggregateStore).toBe('d1');
    expect(paid.aggregateStore).toBe('kv');
    // Free must stay under the 50-subrequest per-invocation ceiling with room
    // for GitHub polling, push delivery, and check retries.
    expect(free.checkBudget).toBeLessThan(50);
    expect(free.clientPollMs).toBeGreaterThan(paid.clientPollMs);
  });

  test('env overrides win over the profile default', () => {
    const p = resolvePlan(env({ PLAN: 'free', CHECK_BUDGET: '12', HISTORY_RETENTION_DAYS: '30' }));
    expect(p.checkBudget).toBe(12);
    // Retention must be overridable: without this, switching paid -> free
    // silently deletes 23 days of history on the next cleanup tick.
    expect(p.historyRetentionDays).toBe(30);
  });

  test('rejects malformed numeric overrides rather than coercing', () => {
    for (const bad of ['0', '-5', '1.5', 'lots']) {
      expect(() => resolvePlan(env({ CHECK_BUDGET: bad }))).toThrow(/CHECK_BUDGET/);
    }
  });
});

describe('ddnsCacheTtlSeconds', () => {
  // The TTL must outlive the gap between ticks; if it lapses, every dashboard
  // request falls back to a 200-row D1 query.
  test('covers several cron intervals', () => {
    expect(ddnsCacheTtlSeconds(resolvePlan(env({ PLAN: 'free' })))).toBeGreaterThanOrEqual(5 * 60 * 2);
    expect(ddnsCacheTtlSeconds(resolvePlan(env({ PLAN: 'paid' })))).toBeGreaterThanOrEqual(60 * 2);
  });

  test("never returns a TTL below KV's 60-second floor", () => {
    const p = resolvePlan(env({ PLAN: 'paid', CRON_INTERVAL_MINUTES: '1' }));
    expect(ddnsCacheTtlSeconds(p)).toBeGreaterThanOrEqual(60);
  });
});

describe('isNthTick', () => {
  test('every tick when the interval is 1', () => {
    const p = resolvePlan(env({ PLAN: 'paid' }));
    expect(isNthTick(7, p, 1)).toBe(true);
    expect(isNthTick(8, p, 1)).toBe(true);
  });

  test('accounts for the cron interval, not just wall-clock minutes', () => {
    const free = resolvePlan(env({ PLAN: 'free' })); // 5-minute cron
    // Tick index = minute / 5, so every 12th tick is hourly.
    expect(isNthTick(0, free, 12)).toBe(true);
    expect(isNthTick(60, free, 12)).toBe(true);
    expect(isNthTick(35, free, 12)).toBe(false);
  });
});
