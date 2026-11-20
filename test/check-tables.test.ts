/**
 * Migration 0013's move to the cheaper `checks` table, run against real SQLite
 * (the engine under D1) with the shipped migrations and the real query code.
 * Covers both tables while `checks_legacy` drains, the id binary search, and
 * that time-bounded reads on `checks` stay on an index.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksSince, DELETE_CHECKS_BEFORE, firstIdAtOrAfter } from '../src/check-tables';
import { addToHistory, cleanupHistory, deleteServiceHistory, getCheckHistory, getRecentErrors } from '../src/storage';
import { backfillRollup, getChartFromRollup } from '../src/storage-free';
import type { CheckResult } from '../src/types';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Apply migrations numbered from..upTo, inclusive. */
function migrate(db: Database, upTo = Infinity, from = 0) {
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()) {
    const n = Number(f.slice(0, 4));
    if (n < from || n > upTo) continue;
    db.run(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
}

/** D1 over bun:sqlite, as in secret-services.test.ts. */
function d1(db: Database): D1Database {
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...p: unknown[]) => statement(sql, p),
    async run() {
      return { success: true, meta: { changes: db.query(sql).run(...(params as [])).changes } };
    },
    async all() {
      return { results: db.query(sql).all(...(params as [])), success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    async batch(stmts: { run(): Promise<unknown> }[]) {
      for (const s of stmts) await s.run();
    },
  } as unknown as D1Database;
}

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

const now = Date.now();

/** A database that had old-schema rows when 0013 ran, as a real deployment will. */
function setup() {
  const raw = new Database(':memory:');
  migrate(raw, 12);
  const ins = raw.query(
    `INSERT INTO checks (service, url, type, status, code, latency, error, source, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of [
    check('a', now - 31 * DAY),
    check('a', now - 3 * MIN),
    check('a', now - 2 * MIN, { status: 'down', error: 'Timeout' }),
    check('b', now - 2 * MIN, { status: 'down', error: 'HTTP 502' }),
  ]) {
    ins.run(r.service, r.url, r.type, r.status, r.code ?? null, r.latency, r.error ?? null, r.source, r.timestamp);
  }
  migrate(raw, Infinity, 13);
  return { raw, db: d1(raw) };
}

const count = (raw: Database, sql: string) => (raw.query(sql).get() as { n: number }).n;

describe('migration 0013', () => {
  test('keeps old rows in checks_legacy and gives checks the cheap shape', () => {
    const { raw } = setup();
    expect(count(raw, 'SELECT COUNT(*) AS n FROM checks_legacy')).toBe(4);
    expect(count(raw, 'SELECT COUNT(*) AS n FROM checks')).toBe(0);
    const sql = (raw.query(`SELECT sql FROM sqlite_master WHERE name = 'checks'`).get() as { sql: string }).sql;
    expect(sql).not.toContain('AUTOINCREMENT');
    expect(
      raw.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'checks' ORDER BY name`).all(),
    ).toEqual([{ name: 'idx_checks_down_ts' }, { name: 'idx_checks_svc_ts' }]);
  });

  test('new inserts no longer touch sqlite_sequence', async () => {
    const { raw, db } = setup();
    await addToHistory(db, [check('a', now)]);
    expect(raw.query(`SELECT name FROM sqlite_sequence WHERE name = 'checks'`).all()).toEqual([]);
    expect(count(raw, 'SELECT COUNT(*) AS n FROM checks')).toBe(1);
  });
});

describe('readers see both tables', () => {
  test('history popup merges and limits across tables', async () => {
    const { db } = setup();
    await addToHistory(db, [check('a', now - MIN), check('a', now)]);
    const h = await getCheckHistory(db, 'a', 'https://a/', 3);
    expect(h.map(e => now - e.timestamp)).toEqual([0, MIN, 2 * MIN]);
  });

  test('/errors merges down rows, optionally per service', async () => {
    const { db } = setup();
    await addToHistory(db, [check('b', now, { status: 'down', error: 'HTTP 500' })]);
    expect((await getRecentErrors(db)).map(e => [e.service, e.error])).toEqual([
      ['b', 'HTTP 500'],
      ['a', 'Timeout'],
      ['b', 'HTTP 502'],
    ]);
    expect((await getRecentErrors(db, 'a')).map(e => e.service)).toEqual(['a']);
    expect(await getRecentErrors(db, 'b', 1)).toHaveLength(1);
  });

  test("free chart's raw tail and the rollup backfill read both tables", async () => {
    const { raw, db } = setup();
    await addToHistory(db, [check('a', now - 8 * 60 * MIN), check('a', now - MIN)]); // ids rise with time
    const chart = await getChartFromRollup(db, 7);
    // Raw tail: two legacy points and one new one inside 6 h. (The 8 h-old point
    // is the rollup's job, and nothing has rolled up yet.)
    expect(chart.a.map(p => now - p[0])).toEqual([3 * MIN, 2 * MIN, MIN]);

    expect(await backfillRollup(db, 7)).toBeGreaterThan(0);
    expect((raw.query('SELECT SUM(totals) AS n FROM uptime_hourly').get() as { n: number }).n).toBe(5); // 3 legacy (one is past 7 days) + 2 new
  });
});

describe('retention', () => {
  test('deletes old rows from both tables and keeps the rest', async () => {
    const { raw, db } = setup();
    await addToHistory(db, [check('a', now - 40 * DAY), check('a', now - 35 * DAY), check('a', now)]);
    expect(await cleanupHistory(db, 30)).toBe(3); // 1 legacy + 2 new
    expect(count(raw, 'SELECT COUNT(*) AS n FROM checks')).toBe(1);
    expect(count(raw, 'SELECT COUNT(*) AS n FROM checks_legacy')).toBe(3);
  });

  test('deleteServiceHistory clears a service from both tables', async () => {
    const { raw, db } = setup();
    await addToHistory(db, [check('a', now)]);
    expect(await deleteServiceHistory(db, 'a')).toBe(4);
    expect(count(raw, `SELECT COUNT(*) AS n FROM checks_legacy WHERE service = 'a'`)).toBe(0);
  });
});

describe('id binary search', () => {
  /** ids with gaps (every third missing), timestamp = id * 10. */
  function table(ids: number[]) {
    const raw = new Database(':memory:');
    migrate(raw);
    const ins = raw.query(
      `INSERT INTO checks (id, service, url, type, status, latency, source, timestamp)
       VALUES (?, 'a', 'u', 'https', 'up', 1, 'edge', ?)`,
    );
    for (const id of ids) ins.run(id, id * 10);
    return raw;
  }
  const first = (raw: Database, cutoff: number) =>
    (raw.query(`SELECT ${firstIdAtOrAfter('?1')} AS id`).get(cutoff) as { id: number | null }).id;

  test('splits rows exactly at the cutoff, with gaps and negative ids', () => {
    for (const ids of [
      Array.from({ length: 1000 }, (_, i) => i + 1).filter(id => id % 3),
      Array.from({ length: 1000 }, (_, i) => i - 700).filter(id => id % 3), // spans negative ids
    ]) {
      const raw = table(ids);
      for (const cutoff of [-99_999, ids[0] * 10, ids[0] * 10 + 1, 0, 1, 4995, 5000, 5001, 10_000, 99_999]) {
        // The boundary may land in a gap; what matters is which rows fall on each side.
        const boundary = first(raw, cutoff)!;
        expect([cutoff, ids.filter(id => id >= boundary)]).toEqual([cutoff, ids.filter(id => id * 10 >= cutoff)]);
      }
    }
  });

  test('empty table: no cutoff, and retention deletes nothing', () => {
    const raw = table([]);
    expect(first(raw, 100)).toBeNull();
    expect(raw.query(DELETE_CHECKS_BEFORE).run(100).changes).toBe(0);
  });

  test('retention deletes exactly the rows before the cutoff', () => {
    const raw = table([1, 2, 4, 5, 7, 8]);
    expect(raw.query(DELETE_CHECKS_BEFORE).run(45).changes).toBe(3);
    expect(raw.query('SELECT id FROM checks ORDER BY id').all()).toEqual([{ id: 5 }, { id: 7 }, { id: 8 }]);
  });
});

describe('query plans stay on indexes', () => {
  const plan = (raw: Database, sql: string, ...args: unknown[]) =>
    (raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as [])) as { detail: string }[]).map(r => r.detail).join('\n');

  test('retention and time-bounded reads probe the primary key, never scan', () => {
    const { raw } = setup();
    for (const sql of [DELETE_CHECKS_BEFORE, `SELECT * FROM checks WHERE ${checksSince('checks', '?1')}`]) {
      const p = plan(raw, sql, now);
      expect(p).not.toMatch(/SCAN checks(?! USING)/);
      expect(p).toContain('USING INTEGER PRIMARY KEY');
    }
  });

  test('/errors uses the partial down-only index', () => {
    const { raw } = setup();
    const p = plan(
      raw,
      `SELECT timestamp FROM checks WHERE status = 'down' AND timestamp > ?1 ORDER BY timestamp DESC LIMIT 100`,
      0,
    );
    expect(p).toContain('idx_checks_down_ts');
  });
});
