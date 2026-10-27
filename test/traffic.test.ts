/**
 * What a flood of page views costs: the generation memo (chart and uptime reads
 * reused until the next tick) and the per-IP rate limiter. Both are exercised
 * through the real worker handler, with D1 queries counted at the shim.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAuthCookie } from '../src/auth';
import { config } from '../src/config';
import { createWorker } from '../src/index';
import type { Env } from '../src/types';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

function migrate(): Database {
  const db = new Database(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()) {
    db.run(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

/** D1 over bun:sqlite, recording every SQL string it's asked to prepare. */
function d1(db: Database, log: string[]): D1Database {
  return {
    prepare(sql: string) {
      log.push(sql);
      let params: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) {
          params = p;
          return stmt;
        },
        async first() {
          return db.query(sql).get(...(params as [])) ?? null;
        },
        async run() {
          const r = db.query(sql).run(...(params as []));
          return { success: true, meta: { changes: r.changes } };
        },
        async all() {
          return { results: db.query(sql).all(...(params as [])), success: true, meta: {} };
        },
      };
      return stmt;
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

const realFetch = globalThis.fetch;
let sqlite: Database;
let queries: string[];

beforeEach(() => {
  sqlite = migrate();
  queries = [];
  // Every service check gets a 200, so a tick has something to record.
  globalThis.fetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function envFor(o: Partial<Env> = {}): Env {
  return { PLAN: 'free', DB: d1(sqlite, queries), ...o } as Env;
}

async function tick(worker: ExportedHandler<Env>, env: Env, scheduledTime: number) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled!(
    { scheduledTime, cron: '*/5 * * * *', noRetry() {} } as ScheduledController,
    env,
    ctx as unknown as ExecutionContext,
  );
  await Promise.all(pending);
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function view(worker: ExportedHandler<Env>, env: Env, path = '/', headers: Record<string, string> = {}) {
  const res = await worker.fetch!(
    new Request(`https://status.example${path}`, { headers }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  await res.text(); // the dashboard streams its chart data; drain it
  return res;
}

const rollupReads = () => queries.filter(q => /FROM uptime_hourly/.test(q)).length;

describe('generation memo', () => {
  test('repeat views reuse chart and uptime reads until the next tick', async () => {
    const worker = createWorker({ config });
    const env = envFor();
    await tick(worker, env, Date.now());

    queries.length = 0;
    await view(worker, env);
    const perView = rollupReads();
    expect(perView).toBeGreaterThan(0);

    queries.length = 0;
    for (let i = 0; i < 5; i++) await view(worker, env);
    await view(worker, env, '/api/poll?full');
    expect(rollupReads()).toBe(0);

    // A tick writes a new status, so the next view reads fresh data once.
    await new Promise(r => setTimeout(r, 2));
    await tick(worker, env, Date.now());
    queries.length = 0;
    await view(worker, env);
    await view(worker, env);
    expect(rollupReads()).toBe(perView);
  });

  test('separate workers keep separate memos', async () => {
    const env = envFor();
    await tick(createWorker({ config }), env, Date.now());
    await view(createWorker({ config }), env);
    queries.length = 0;
    await view(createWorker({ config }), env);
    expect(rollupReads()).toBeGreaterThan(0);
  });

  test('with no data yet, nothing is remembered', async () => {
    const worker = createWorker({ config });
    const env = envFor();
    await view(worker, env);
    await tick(worker, env, Date.now());
    queries.length = 0;
    await view(worker, env);
    expect(rollupReads()).toBeGreaterThan(0);
  });
});

describe('rate limiter', () => {
  const secrets = { DASHBOARD_PASSWORD: 'pw', AUTH_SECRET: 'signing-secret', PUBLIC_DASHBOARD: 'true' };
  const ip = { 'CF-Connecting-IP': '203.0.113.7' };

  /** A binding that allows `limit` calls per key, recording the keys it saw. */
  function limiter(limit: number) {
    const counts = new Map<string, number>();
    return {
      keys: [] as string[],
      async limit({ key }: { key: string }) {
        this.keys.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= limit };
      },
    };
  }

  test('an anonymous client past its limit gets a 429', async () => {
    const rl = limiter(2);
    const env = envFor({ ...secrets, RATE_LIMITER: rl as unknown as RateLimit });
    const worker = createWorker({ config });
    expect((await view(worker, env, '/', ip)).status).toBe(200);
    expect((await view(worker, env, '/api/poll', ip)).status).toBe(200);
    const limited = await view(worker, env, '/', ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(rl.keys).toEqual(['203.0.113.7', '203.0.113.7', '203.0.113.7']);

    // A different client is unaffected.
    expect((await view(worker, env, '/', { 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(200);
  });

  test('login attempts count too', async () => {
    const env = envFor({ ...secrets, RATE_LIMITER: limiter(0) as unknown as RateLimit });
    const res = await createWorker({ config }).fetch!(
      new Request('https://status.example/login', {
        method: 'POST',
        headers: ip,
        body: new URLSearchParams({ passphrase: 'guess' }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    expect(res.status).toBe(429);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM login_attempts`).get()).toEqual({ n: 0 });
  });

  test('admins, static assets and the health probe are never limited', async () => {
    const rl = limiter(0);
    const env = envFor({ ...secrets, RATE_LIMITER: rl as unknown as RateLimit });
    const worker = createWorker({ config });
    const cookie = (await buildAuthCookie(env, true)).split(';')[0];
    expect((await view(worker, env, '/', { ...ip, Cookie: cookie })).status).toBe(200);
    expect((await view(worker, env, '/icon.svg', ip)).status).toBe(200);
    expect((await view(worker, env, '/health', ip)).status).toBe(200);
    expect(rl.keys).toEqual([]);
  });

  test('fails open: no binding, no client IP, or a binding error', async () => {
    const worker = createWorker({ config });
    expect((await view(worker, envFor(secrets), '/', ip)).status).toBe(200);

    const rl = limiter(0);
    expect((await view(worker, envFor({ ...secrets, RATE_LIMITER: rl as unknown as RateLimit }), '/')).status).toBe(
      200,
    );

    const broken = {
      async limit() {
        throw new Error('binding unavailable');
      },
    };
    const env = envFor({ ...secrets, RATE_LIMITER: broken as unknown as RateLimit });
    expect((await view(worker, env, '/', ip)).status).toBe(200);
  });
});
