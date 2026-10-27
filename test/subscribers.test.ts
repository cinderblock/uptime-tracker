/**
 * Per-device notification settings: the dispatch rules, the migration that
 * carries existing deployments over, and the device-facing API.
 */

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAuthCookie } from '../src/auth';
import { config } from '../src/config';
import { createWorker } from '../src/index';
import {
  effectiveSettings,
  planServiceNotifications,
  type ServiceObservation,
  type SettingsByKey,
  type Subscriber,
} from '../src/subscribers';
import type { Env, NotificationSettings } from '../src/types';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .sort();

function migrate(upTo?: string): Database {
  const db = new Database(':memory:');
  for (const file of migrationFiles) {
    if (upTo && file >= upTo) break;
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

// ── Dispatch rules ───────────────────────────────────────────────────────────

const on = (o: Partial<NotificationSettings> = {}): NotificationSettings => ({
  enabled: 1,
  failure_threshold: 1,
  notify_recovery: 0,
  urgency: null,
  ...o,
});

let nextId = 1;
const device = (o: Partial<Subscriber> = {}): Subscriber => ({
  id: nextId++,
  endpoint: `https://push.example/${nextId}`,
  p256dh: 'k',
  auth: 'a',
  is_admin: 1,
  default_enabled: 0,
  ...o,
});

const down = (key: string, consecutiveDown: number): ServiceObservation => ({
  key,
  name: key,
  down: true,
  consecutiveDown,
});
const up = (key: string): ServiceObservation => ({ key, name: key, down: false, consecutiveDown: 0 });

function plan(
  services: ServiceObservation[],
  subs: Subscriber[],
  settings: Record<number, SettingsByKey> = {},
  notified: Record<number, string[]> = {},
) {
  return planServiceNotifications(
    services,
    subs,
    new Map(Object.entries(settings).map(([id, s]) => [Number(id), s])),
    new Map(Object.entries(notified).map(([id, k]) => [Number(id), new Set(k)])),
  );
}

describe('dispatch rules', () => {
  test('each device applies its own threshold', () => {
    const quick = device();
    const patient = device();
    const settings = { [quick.id]: { a: on() }, [patient.id]: { a: on({ failure_threshold: 3 }) } };

    const tick1 = plan([down('a', 1)], [quick, patient], settings);
    expect(tick1.map(p => p.sub.id)).toEqual([quick.id]);

    const tick3 = plan([down('a', 3)], [quick, patient], settings, { [quick.id]: ['a'] });
    const p = tick3.find(x => x.sub.id === patient.id)!;
    expect(p.newlyDown.map(s => s.key)).toEqual(['a']);
    // The quick device was already told, so it has nothing new.
    expect(tick3.find(x => x.sub.id === quick.id)).toBeUndefined();
  });

  test('a disabled service sends nothing to that device', () => {
    const d = device();
    expect(plan([down('a', 5)], [d], { [d.id]: { a: on({ enabled: 0 }) } })).toEqual([]);
  });

  test('already-down services are listed so the replacing notice stays complete', () => {
    const d = device();
    const [p] = plan([down('a', 4), down('b', 1)], [d], { [d.id]: { a: on(), b: on() } }, { [d.id]: ['a'] });
    expect(p.newlyDown.map(s => s.key)).toEqual(['b']);
    expect(p.alreadyDown).toEqual(['a']);
  });

  test('recovery: noticed only if wanted, but the mark is always cleared', () => {
    const wants = device();
    const doesnt = device();
    const settings = { [wants.id]: { a: on({ notify_recovery: 1 }) }, [doesnt.id]: { a: on() } };
    const plans = plan([up('a')], [wants, doesnt], settings, { [wants.id]: ['a'], [doesnt.id]: ['a'] });
    const w = plans.find(p => p.sub.id === wants.id)!;
    const d = plans.find(p => p.sub.id === doesnt.id)!;
    expect(w.recovered.map(s => s.key)).toEqual(['a']);
    expect(d.recovered).toEqual([]);
    expect(w.cleared).toEqual(['a']);
    expect(d.cleared).toEqual(['a']);
  });

  test('urgency is the highest among the services that fired', () => {
    const d = device();
    const [p] = plan([down('a', 1), down('b', 1)], [d], {
      [d.id]: { a: on({ urgency: 'low' }), b: on({ urgency: 'high' }) },
    });
    expect(p.downUrgency).toBe('high');
  });
});

describe('defaults for keys a device never set', () => {
  test('pre-existing devices keep "no row means off"', () => {
    expect(effectiveSettings(device({ default_enabled: 0 }), {}, 'a').enabled).toBe(0);
  });

  test('new devices get services on, with recovery notices', () => {
    const s = effectiveSettings(device({ default_enabled: 1 }), {}, 'a');
    expect(s).toEqual({ enabled: 1, failure_threshold: 1, notify_recovery: 1, urgency: null });
  });

  test('GitHub workflows stay opt-in, since each costs an API call per tick', () => {
    expect(effectiveSettings(device({ default_enabled: 1 }), {}, 'gh:o/r/ci.yml').enabled).toBe(0);
  });

  test('DDNS is admin-only, even with an explicit row', () => {
    const anon = device({ is_admin: 0, default_enabled: 1 });
    expect(effectiveSettings(anon, { ddns: on() }, 'ddns').enabled).toBe(0);
    expect(effectiveSettings(device({ default_enabled: 1 }), {}, 'ddns').enabled).toBe(1);
  });
});

// ── Migration carry-over ─────────────────────────────────────────────────────

describe('migration 0012 carries existing deployments over', () => {
  test('every device keeps the old global settings and outage marks', () => {
    const db = migrate('0012');
    db.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES ('e1','k','a',1), ('e2','k','a',1)`,
    );
    db.run(`DELETE FROM notification_settings`); // drop 0007's DDNS seed for a clean count
    db.run(
      `INSERT INTO notification_settings (key, enabled, failure_threshold, notify_recovery, urgency, updated_at)
       VALUES ('a.example', 1, 3, 1, 'high', 1), ('b.example', 0, 1, 0, NULL, 1)`,
    );
    db.run(`INSERT INTO notification_state (key, consecutive_down, notified_down) VALUES ('a.example', 5, 1)`);

    for (const file of migrationFiles.filter(f => f >= '0012')) {
      db.run(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }

    const subs = db.query(`SELECT endpoint, is_admin, default_enabled FROM push_subscriptions ORDER BY id`).all();
    expect(subs).toEqual([
      { endpoint: 'e1', is_admin: 1, default_enabled: 0 },
      { endpoint: 'e2', is_admin: 1, default_enabled: 0 },
    ]);
    const settings = db
      .query(
        `SELECT subscription_id AS id, key, enabled, failure_threshold AS t, notify_recovery AS r, urgency
         FROM subscription_settings ORDER BY id, key`,
      )
      .all();
    expect(settings).toEqual([
      { id: 1, key: 'a.example', enabled: 1, t: 3, r: 1, urgency: 'high' },
      { id: 1, key: 'b.example', enabled: 0, t: 1, r: 0, urgency: null },
      { id: 2, key: 'a.example', enabled: 1, t: 3, r: 1, urgency: 'high' },
      { id: 2, key: 'b.example', enabled: 0, t: 1, r: 0, urgency: null },
    ]);
    const state = db.query(`SELECT subscription_id AS id, key FROM subscription_state ORDER BY id`).all();
    expect(state).toEqual([
      { id: 1, key: 'a.example' },
      { id: 2, key: 'a.example' },
    ]);
  });
});

// ── Device-facing API, through the worker ────────────────────────────────────

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const worker = createWorker({ config });
const serviceKey = (() => {
  const h = config.panels[0].services[0].host;
  return Array.isArray(h) ? h[0] : h;
})();

let sqlite: Database;
beforeEach(() => {
  sqlite = migrate();
});

const baseEnv = (o: Partial<Env> = {}): Env =>
  ({
    PLAN: 'free',
    DB: d1(sqlite),
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'mailto:x@example.com',
    DASHBOARD_PASSWORD: 'admin pass',
    AUTH_SECRET: 'secret',
    PUBLIC_DASHBOARD: 'true',
    ...o,
  }) as Env;

async function post(env: Env, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie.split(';')[0];
  return worker.fetch!(
    new Request(`https://status.example${path}`, { method: 'POST', headers, body: JSON.stringify(body) }) as never,
    env,
    ctx,
  );
}

const subscribeBody = (endpoint: string, code?: string) => ({ endpoint, keys: { p256dh: 'k', auth: 'a' }, code });

describe('subscribing', () => {
  test('anyone may subscribe when no code is set, as a non-admin device', async () => {
    const env = baseEnv();
    expect((await post(env, '/api/subscribe', subscribeBody('https://push.example/1'))).status).toBe(200);
    expect(sqlite.query(`SELECT is_admin, default_enabled FROM push_subscriptions`).get()).toEqual({
      is_admin: 0,
      default_enabled: 1,
    });
  });

  test('with SUBSCRIBE_PASSWORD, the code is required, and admins are exempt', async () => {
    const env = baseEnv({ SUBSCRIBE_PASSWORD: 'roses' });
    const missing = await post(env, '/api/subscribe', subscribeBody('https://push.example/1'));
    expect(missing.status).toBe(403);
    expect((await post(env, '/api/subscribe', subscribeBody('https://push.example/1', 'nope'))).status).toBe(403);
    expect((await post(env, '/api/subscribe', subscribeBody('https://push.example/1', 'roses'))).status).toBe(200);

    const cookie = await buildAuthCookie(env, true);
    expect((await post(env, '/api/subscribe', subscribeBody('https://push.example/2'), cookie)).status).toBe(200);
    const admin = sqlite.query(`SELECT is_admin FROM push_subscriptions WHERE endpoint LIKE '%/2'`).get();
    expect(admin).toEqual({ is_admin: 1 });
  });

  test('the cap stops new strangers but not known devices or admins', async () => {
    const env = baseEnv({ MAX_SUBSCRIPTIONS: '1' });
    expect((await post(env, '/api/subscribe', subscribeBody('https://push.example/1'))).status).toBe(200);
    expect((await post(env, '/api/subscribe', subscribeBody('https://push.example/2'))).status).toBe(429);
    expect((await post(env, '/api/subscribe', subscribeBody('https://push.example/1'))).status).toBe(200);
    const cookie = await buildAuthCookie(env, true);
    expect((await post(env, '/api/subscribe', subscribeBody('https://push.example/3'), cookie)).status).toBe(200);
  });

  test('an anonymous re-subscribe never demotes an admin device', async () => {
    const env = baseEnv();
    const cookie = await buildAuthCookie(env, true);
    await post(env, '/api/subscribe', subscribeBody('https://push.example/1'), cookie);
    await post(env, '/api/subscribe', subscribeBody('https://push.example/1'));
    expect(sqlite.query(`SELECT is_admin FROM push_subscriptions`).get()).toEqual({ is_admin: 1 });
  });

  test('unsubscribing removes the device and its settings', async () => {
    const env = baseEnv();
    const ep = 'https://push.example/1';
    await post(env, '/api/subscribe', subscribeBody(ep));
    await post(env, '/api/notification-settings', { endpoint: ep, key: serviceKey, enabled: 0 });
    await post(env, '/api/unsubscribe', { endpoint: ep });
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM push_subscriptions`).get()).toEqual({ n: 0 });
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM subscription_settings`).get()).toEqual({ n: 0 });
  });
});

describe('a device managing its own settings', () => {
  const ep = 'https://push.example/1';

  test('reads every key, defaulting new devices to on', async () => {
    const env = baseEnv();
    await post(env, '/api/subscribe', subscribeBody(ep));
    const res = await post(env, '/api/notification-settings', { endpoint: ep });
    const { settings } = (await res.json()) as { settings: Record<string, NotificationSettings> };
    expect(settings[serviceKey]).toEqual({ enabled: 1, failure_threshold: 1, notify_recovery: 1, urgency: null });
  });

  test('changes stick, and only for that device', async () => {
    const env = baseEnv();
    await post(env, '/api/subscribe', subscribeBody(ep));
    await post(env, '/api/subscribe', subscribeBody('https://push.example/other'));
    const set = await post(env, '/api/notification-settings', {
      endpoint: ep,
      key: serviceKey,
      enabled: 1,
      failure_threshold: 4,
      notify_recovery: 0,
      urgency: 'low',
    });
    expect(set.status).toBe(200);

    const read = async (endpoint: string) =>
      ((await (await post(env, '/api/notification-settings', { endpoint })).json()) as { settings: SettingsByKey })
        .settings[serviceKey];
    expect(await read(ep)).toEqual({ enabled: 1, failure_threshold: 4, notify_recovery: 0, urgency: 'low' });
    expect((await read('https://push.example/other')).failure_threshold).toBe(1);
  });

  test('an unknown endpoint gets 404, not someone else’s settings', async () => {
    const res = await post(baseEnv(), '/api/notification-settings', { endpoint: 'https://push.example/nobody' });
    expect(res.status).toBe(404);
  });

  test('made-up keys are refused, so the table cannot be filled with junk', async () => {
    const env = baseEnv();
    await post(env, '/api/subscribe', subscribeBody(ep));
    const res = await post(env, '/api/notification-settings', { endpoint: ep, key: 'junk', enabled: 1 });
    expect(res.status).toBe(400);
  });

  test('the endpoint is only accepted in a POST body, never a URL', async () => {
    const res = await worker.fetch!(
      new Request(`https://status.example/api/notification-settings?endpoint=${encodeURIComponent(ep)}`) as never,
      baseEnv(),
      ctx,
    );
    expect(res.status).toBe(405);
  });
});
