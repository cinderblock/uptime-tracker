/**
 * Exercises the shipped migration SQL against real SQLite.
 *
 * These queries only ever run against D1 in production, where a mistake shows
 * up as a wrong number on a dashboard rather than an error. Loading the actual
 * migration files (not a copy) means schema drift breaks a test instead.
 */

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const HOUR_MS = 3_600_000;

function migrate(): Database {
  const db = new Database(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()) {
    db.run(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

function seed(db: Database, rows: Array<{ service: string; status: string; latency: number; ageMs: number }>) {
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO checks (service,url,type,status,code,latency,error,source,timestamp) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  db.run('BEGIN');
  for (const r of rows) {
    ins.run(r.service, `https://${r.service}/`, 'https', r.status, 200, r.latency, null, 'edge', now - r.ageMs);
  }
  db.run('COMMIT');
}

let db: Database;
beforeEach(() => {
  db = migrate();
});

describe('schema', () => {
  test('every migration applies cleanly in filename order', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    for (const t of ['checks', 'current_status', 'ddns_log', 'uptime_hourly', 'blobs']) {
      expect(tables).toContain(t);
    }
  });

  // Duplicate migration numbers are tolerated by wrangler (it keys on the full
  // filename), but two files claiming the same number in THIS repo would be a
  // mistake — the ordering between them would be alphabetical and implicit.
  test('no two migrations share a number', () => {
    const numbers = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .map(f => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  test('DDNS notifications ship disabled, so forks are not opted in', () => {
    const row = db.prepare(`SELECT enabled FROM notification_settings WHERE key = 'ddns'`).get() as any;
    expect(row?.enabled).toBe(0);
  });
});

describe('uptime_hourly rollup', () => {
  const upsert = `INSERT INTO uptime_hourly (service, hb, ups, totals, lat_sum, lat_max)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(service, hb) DO UPDATE SET
       ups = uptime_hourly.ups + excluded.ups,
       totals = uptime_hourly.totals + excluded.totals,
       lat_sum = uptime_hourly.lat_sum + excluded.lat_sum,
       lat_max = max(uptime_hourly.lat_max, excluded.lat_max)`;

  test('accumulates across ticks within the same hour', () => {
    const stmt = db.prepare(upsert);
    stmt.run('svc', 100, 3, 3, 300, 120);
    stmt.run('svc', 100, 0, 1, 900, 900); // a later tick, one failure, slower
    const row = db.prepare(`SELECT * FROM uptime_hourly WHERE service='svc' AND hb=100`).get() as any;
    expect(row.ups).toBe(3);
    expect(row.totals).toBe(4);
    expect(row.lat_sum).toBe(1200);
    expect(row.lat_max).toBe(900); // max, not last-write-wins
  });
});

describe('backfillRollup (PLAN=paid -> free)', () => {
  const backfill = `INSERT INTO uptime_hourly (service, hb, ups, totals, lat_sum, lat_max)
     SELECT service, CAST(timestamp / ${HOUR_MS} AS INTEGER) AS hb,
            SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END), COUNT(*), SUM(latency), MAX(latency)
     FROM checks WHERE timestamp > ? GROUP BY service, hb
     ON CONFLICT(service, hb) DO NOTHING`;

  test('rebuilds from checks, respects retention, and is idempotent', () => {
    seed(db, [
      { service: 'a', status: 'up', latency: 100, ageMs: 60_000 },
      { service: 'a', status: 'down', latency: 900, ageMs: 120_000 },
      { service: 'b', status: 'up', latency: 50, ageMs: 60_000 },
      { service: 'a', status: 'up', latency: 100, ageMs: 40 * 24 * HOUR_MS }, // beyond retention
    ]);

    const since = Date.now() - 7 * 24 * HOUR_MS;
    const first = db.prepare(backfill).run(since);
    expect(first.changes).toBeGreaterThan(0);

    const totals = db.prepare(`SELECT SUM(totals) t, SUM(ups) u FROM uptime_hourly`).get() as any;
    expect(totals.t).toBe(3); // the 40-day-old row is excluded
    expect(totals.u).toBe(2); // one of the three was down

    // Re-running must not double-count — it's called whenever the table looks empty.
    expect(db.prepare(backfill).run(since).changes).toBe(0);
  });
});

describe('errors query (migration 0010)', () => {
  test('uses the status index rather than walking the timestamp index', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT service FROM checks WHERE status = 'down' AND timestamp > ?
         ORDER BY timestamp DESC LIMIT 100`,
      )
      .all(0)
      .map((r: any) => r.detail)
      .join(' ');
    // Without idx_checks_status_timestamp this scans every healthy row to find
    // the failures — the healthier the fleet, the more it reads.
    expect(plan).toContain('idx_checks_status_timestamp');
  });
});
