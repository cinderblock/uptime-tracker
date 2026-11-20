import { describe, expect, test } from 'bun:test';
import { createGenerationMemo } from '../src/read-memo';
import {
  accumulateRecent,
  emptyRecent,
  foldChart,
  foldUptime,
  getChartData,
  getMultiPeriodUptime,
  hourBucket,
  mergeIntoBucket,
  recordTickRollups,
  type ChartDataPoint,
} from '../src/rollups';
import type { CheckResult } from '../src/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Fixed, hour-aligned base so tests don't depend on the wall clock's minute.
const T0 = Date.UTC(2026, 10, 13, 20, 0);

function check(service: string, timestamp: number, over: Partial<CheckResult> = {}): CheckResult {
  return {
    service,
    url: `https://${service}/`,
    type: 'https',
    status: 'up',
    code: 200,
    latency: 100,
    source: 'edge',
    timestamp,
    ...over,
  } as CheckResult;
}

/** In-memory KV that counts writes per key. */
function memKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const puts: string[] = [];
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      puts.push(k);
      store.set(k, v);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts, json: (k: string) => JSON.parse(store.get(k) ?? 'null') };
}

const emptyCold = { 'cache:chart-tiered': {}, 'cache:uptime-buckets': {} };

describe('mergeIntoBucket', () => {
  test('keeps worst-of-bucket and ascending order', () => {
    const arr: ChartDataPoint[] = [];
    mergeIntoBucket(arr, [T0 + 2 * MIN, 50, 1], MIN);
    mergeIntoBucket(arr, [T0, 50, 1], MIN);
    mergeIntoBucket(arr, [T0 + MIN, 50, 1], MIN);
    mergeIntoBucket(arr, [T0 + MIN + 1, 10, 0], MIN); // down beats up in the same minute
    mergeIntoBucket(arr, [T0 + 2 * MIN + 1, 999, 1], MIN); // higher latency wins a tie
    expect(arr.map(p => [p[0] - T0, p[2]])).toEqual([
      [0, 1],
      [MIN + 1, 0],
      [2 * MIN + 1, 1],
    ]);
  });
});

describe('accumulate and fold', () => {
  test('folding recent into cold equals what the old per-tick update produced', () => {
    const recent = emptyRecent(hourBucket(T0), 0, {});
    accumulateRecent(recent, [check('a', T0), check('a', T0 + MIN, { status: 'down', latency: 5 })]);
    accumulateRecent(recent, [check('a', T0 + 2 * MIN, { url: 'https://a/other' })]); // not the primary URL

    const chart = {};
    const uptime = {};
    foldChart(chart, recent, T0 + HOUR);
    foldUptime(uptime, recent, T0 + HOUR);

    expect(chart).toEqual({
      a: {
        primaryUrl: 'https://a/',
        t1: [
          [T0, 100, 1, 200],
          [T0 + MIN, 5, 0, 200],
        ],
        t10: [],
        t30: [],
        t120: [],
      },
    });
    // Every check counts toward uptime, primary URL or not.
    expect(uptime).toEqual({ a: { [String(hourBucket(T0))]: { ups: 2, totals: 3 } } });
  });

  test("a secret service's direct check is its charted primary check", () => {
    const recent = emptyRecent(hourBucket(T0), 0, {});
    accumulateRecent(recent, [check('s', T0, { type: 'secret', url: 'secret:s' })]);
    accumulateRecent(recent, [check('h', T0, { type: 'http' })]); // plain HTTP is never charted
    expect(recent.primaryUrls).toEqual({ s: 'secret:s' });
    expect(Object.keys(recent.chart)).toEqual(['s']);
  });

  test('fold promotes aged points and drops buckets past 30 days', () => {
    const old = T0 - 31 * 24 * HOUR;
    const chart = {
      a: {
        primaryUrl: 'https://a/',
        t1: [[T0 - 7 * HOUR, 1, 1]] as ChartDataPoint[],
        t10: [] as ChartDataPoint[],
        t30: [] as ChartDataPoint[],
        t120: [] as ChartDataPoint[],
      },
    };
    const uptime = { a: { [String(hourBucket(old))]: { ups: 1, totals: 1 } } };
    const recent = emptyRecent(hourBucket(T0), 0, {});
    foldChart(chart, recent, T0);
    foldUptime(uptime, recent, T0);
    expect(chart.a.t1).toEqual([]);
    expect(chart.a.t10).toEqual([[T0 - 7 * HOUR, 1, 1]]);
    expect(uptime).toEqual({ a: {} });
  });
});

describe('recordTickRollups', () => {
  test('within an hour, only the small blob is written', async () => {
    const { kv, puts } = memKv(emptyCold);
    await recordTickRollups(kv, undefined, [check('a', T0 + MIN)], T0 + MIN); // first ever tick: folds
    puts.length = 0;
    await recordTickRollups(kv, undefined, [check('a', T0 + 2 * MIN)], T0 + 2 * MIN);
    await recordTickRollups(kv, undefined, [check('a', T0 + 3 * MIN)], T0 + 3 * MIN);
    expect(puts).toEqual(['cache:rollups-recent', 'cache:rollups-recent']);
  });

  test('a tick with no results and no fold writes nothing', async () => {
    const { kv, puts } = memKv(emptyCold);
    await recordTickRollups(kv, undefined, [check('a', T0 + MIN)], T0 + MIN);
    puts.length = 0;
    await recordTickRollups(kv, undefined, [], T0 + 2 * MIN);
    expect(puts).toEqual([]);
  });

  test('the first tick of a new hour folds the previous hour into cold', async () => {
    const { kv, json, puts } = memKv(emptyCold);
    await recordTickRollups(kv, undefined, [check('a', T0 + MIN)], T0 + MIN);
    await recordTickRollups(kv, undefined, [check('a', T0 + 59 * MIN)], T0 + 59 * MIN);
    puts.length = 0;
    await recordTickRollups(kv, undefined, [check('a', T0 + HOUR + MIN)], T0 + HOUR + MIN);

    expect(puts.sort()).toEqual(['cache:chart-tiered', 'cache:rollups-recent', 'cache:uptime-buckets']);
    expect(json('cache:chart-tiered').a.t1.map((p: ChartDataPoint) => p[0])).toEqual([T0 + MIN, T0 + 59 * MIN]);
    expect(json('cache:uptime-buckets').a[String(hourBucket(T0))]).toEqual({ ups: 2, totals: 2 });
    const recent = json('cache:rollups-recent');
    expect(recent.hour).toBe(hourBucket(T0 + HOUR));
    expect(recent.coldGen).toBe(T0 + HOUR + MIN);
    expect(recent.primaryUrls).toEqual({ a: 'https://a/' });
    expect(recent.chart.a.map((p: ChartDataPoint) => p[0])).toEqual([T0 + HOUR + MIN]);
  });

  test('a missing cold blob is rebuilt from D1 without counting this tick twice', async () => {
    // D1 already holds this tick's row (the cron inserts before it records rollups).
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({
            results: sql.includes('GROUP BY service, hb')
              ? [{ service: 'a', hb: hourBucket(T0), totals: 1, ups: 1 }]
              : [],
          }),
        }),
      }),
    } as unknown as D1Database;
    const { kv, json } = memKv({ 'cache:chart-tiered': {} }); // uptime blob missing
    await recordTickRollups(kv, db, [check('a', T0 + MIN)], T0 + MIN);
    expect(json('cache:uptime-buckets')).toEqual({ a: { [String(hourBucket(T0))]: { ups: 1, totals: 1 } } });
    const recent = json('cache:rollups-recent');
    expect(recent.uptime).toEqual({}); // already counted by the rebuild
    expect(recent.chart.a).toHaveLength(1); // the chart blob was folded, not rebuilt
  });

  test('a missing cold blob with no D1 is an error, not an empty chart', async () => {
    const { kv } = memKv({});
    expect(recordTickRollups(kv, undefined, [check('a', T0)], T0)).rejects.toThrow('no D1');
  });
});

describe('read path', () => {
  test('combines cold and recent, and memoizes cold until the next fold', async () => {
    const now = Date.now();
    const { kv, store } = memKv(emptyCold);
    await recordTickRollups(kv, undefined, [check('a', now - 2 * HOUR)], now - 2 * HOUR);
    await recordTickRollups(kv, undefined, [check('a', now, { status: 'down' })], now); // folds the first

    const memo = createGenerationMemo();
    const chart = await getChartData(kv, memo);
    expect(chart.a.map(p => p[0])).toEqual([now - 2 * HOUR, now]);
    const uptime = await getMultiPeriodUptime(kv, memo);
    expect(uptime.a.checkCount24h).toBe(2);
    expect(uptime.a.uptime24h).toBe(50);

    // Corrupting the cold blob proves the second read came from memory.
    store.set('cache:chart-tiered', 'not json');
    store.set('cache:uptime-buckets', 'not json');
    expect((await getChartData(kv, memo)).a).toHaveLength(2);
    expect((await getMultiPeriodUptime(kv, memo)).a.checkCount24h).toBe(2);
  });

  test('returns empty before anything has been written', async () => {
    const { kv } = memKv({});
    const memo = createGenerationMemo();
    expect(await getChartData(kv, memo)).toEqual({});
    expect(await getMultiPeriodUptime(kv, memo)).toEqual({});
  });
});
