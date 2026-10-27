/**
 * End-to-end push dispatch: the real scheduled() handler, real Web Push
 * encryption and VAPID signing, and a stubbed network. Service checks get a
 * 500 (so everything is down) and push services record what they receive.
 *
 * This is where the per-tick push budget and "only a delivered notice counts"
 * live, and neither shows up in the pure planner tests.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { b64u } from '../src/base64';
import { config } from '../src/config';
import { createWorker } from '../src/index';
import { resolvePlan } from '../src/plan';
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

function d1(db: Database): D1Database {
  return {
    prepare(sql: string) {
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

async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  return { VAPID_PUBLIC_KEY: b64u(pub), VAPID_PRIVATE_KEY: jwk.d! };
}

/** A browser-side push subscription: an ECDH key pair and an auth secret. */
async function deviceKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  return { p256dh: b64u(pub), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
}

const PUSH_HOST = 'https://push.example/';
let pushes: { endpoint: string; urgency: string | null }[];
let pushStatus: (endpoint: string) => number;
const realFetch = globalThis.fetch;

let sqlite: Database;
let env: Env;

beforeEach(async () => {
  sqlite = migrate();
  pushes = [];
  pushStatus = () => 201;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(PUSH_HOST)) {
      const headers = new Headers(init?.headers);
      pushes.push({ endpoint: url, urgency: headers.get('Urgency') });
      return new Response(null, { status: pushStatus(url) });
    }
    return new Response('down', { status: 500 });
  }) as typeof fetch;
  env = {
    PLAN: 'free',
    DB: d1(sqlite),
    VAPID_SUBJECT: 'mailto:test@example.com',
    ...(await vapidKeys()),
  } as Env;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function addDevices(n: number) {
  for (let i = 0; i < n; i++) {
    const { p256dh, auth } = await deviceKeys();
    sqlite.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, is_admin, default_enabled) VALUES (?, ?, ?, 1, 1, 1)`,
      [`${PUSH_HOST}${i}`, p256dh, auth],
    );
  }
}

async function tick() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await createWorker({ config }).scheduled!(
    { scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController,
    env,
    ctx as unknown as ExecutionContext,
  );
  await Promise.all(pending);
}

const told = () =>
  (sqlite.query(`SELECT COUNT(DISTINCT subscription_id) AS n FROM subscription_state`).get() as { n: number }).n;

describe('push dispatch', () => {
  test('one combined notice per device, and nothing more while still down', async () => {
    await addDevices(3);
    await tick();
    expect(pushes.length).toBe(3);
    expect(told()).toBe(3);

    pushes = [];
    await tick();
    expect(pushes).toEqual([]);
  });

  test('past the budget, the rest are told on the next tick', async () => {
    const budget = resolvePlan(env).pushBudget;
    await addDevices(budget + 2);

    await tick();
    expect(pushes.length).toBe(budget);
    expect(told()).toBe(budget);

    pushes = [];
    await tick();
    expect(pushes.length).toBe(2);
    expect(told()).toBe(budget + 2);
  });

  test('a failed delivery is retried; an expired subscription is removed', async () => {
    await addDevices(2);
    pushStatus = url => (url.endsWith('/0') ? 500 : 410);
    await tick();
    expect(told()).toBe(0);
    expect(sqlite.query(`SELECT endpoint FROM push_subscriptions`).all()).toEqual([{ endpoint: `${PUSH_HOST}0` }]);

    pushes = [];
    pushStatus = () => 201;
    await tick();
    expect(pushes.map(p => p.endpoint)).toEqual([`${PUSH_HOST}0`]);
    expect(told()).toBe(1);
  });

  test('a device that turned a service off is not told about it', async () => {
    await addDevices(1);
    const keys = config.panels.flatMap(p => p.services.map(s => (Array.isArray(s.host) ? s.host[0] : s.host)));
    for (const key of keys) {
      sqlite.run(
        `INSERT INTO subscription_settings (subscription_id, key, enabled, failure_threshold, notify_recovery, updated_at) VALUES (1, ?, 0, 1, 0, 1)`,
        [key],
      );
    }
    await tick();
    expect(pushes).toEqual([]);
  });
});
