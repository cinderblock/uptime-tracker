/**
 * Public mode (PUBLIC_DASHBOARD=true) and login throttling.
 *
 * The gate is exercised through the real worker handler rather than by calling
 * the predicates alone. The failure this guards against is an admin endpoint
 * reachable by an anonymous visitor, and that lives in how the predicates are
 * wired into fetch(), not in the predicates themselves.
 */

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  buildAuthCookie,
  cleanupLoginAttempts,
  isAdminRequest,
  isPublicModePath,
  loginRetryAfter,
  recordLoginFailure,
} from '../src/auth';
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

/** Just enough of D1's API over bun:sqlite for the code paths under test. */
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
          db.query(sql).run(...(params as []));
          return { success: true, meta: {} };
        },
        async all() {
          return { results: db.query(sql).all(...(params as [])), success: true, meta: {} };
        },
      };
      return stmt;
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      return Promise.all(stmts.map(s => s.run()));
    },
  } as unknown as D1Database;
}

const PASSWORD = 'correct horse battery staple';
const secrets = { DASHBOARD_PASSWORD: PASSWORD, AUTH_SECRET: 'signing-secret' };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const worker = createWorker({ config });

let sqlite: Database;
beforeEach(() => {
  sqlite = migrate();
});

function envFor(o: Partial<Env>): Env {
  return { PLAN: 'free', DB: d1(sqlite), ...o } as Env;
}

async function fetchAs(env: Env, path: string, init: RequestInit & { cookie?: string; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie.split(';')[0]);
  headers.set('CF-Connecting-IP', init.ip ?? '203.0.113.7');
  return worker.fetch!(new Request(`https://status.example${path}`, { ...init, headers }) as never, env, ctx);
}

const adminCookie = (env: Env) => buildAuthCookie(env, true);
const isLoginPage = async (res: Response) => (await res.text()).includes('name="passphrase"');

describe('who is an admin', () => {
  const req = (cookie?: string) => new Request('https://x/', cookie ? { headers: { Cookie: cookie } } : {});

  test('no password, no public mode: everyone (the original open mode)', async () => {
    expect(await isAdminRequest({} as Env, req())).toBe(true);
  });

  test('public mode with no password: nobody, since nobody can log in', async () => {
    expect(await isAdminRequest({ PUBLIC_DASHBOARD: 'true' } as Env, req())).toBe(false);
  });

  test.each([
    ['gated', {}],
    ['public', { PUBLIC_DASHBOARD: 'true' }],
  ])('%s with a password: only with a valid cookie', async (_, extra) => {
    const env = { ...secrets, ...extra } as Env;
    expect(await isAdminRequest(env, req())).toBe(false);
    expect(await isAdminRequest(env, req('uptime_auth=v1.9999999999999.forged'))).toBe(false);
    const cookie = (await adminCookie(env)).split(';')[0];
    expect(await isAdminRequest(env, req(cookie))).toBe(true);
  });
});

describe('public-mode allowlist', () => {
  test('the status view is readable', () => {
    expect(isPublicModePath('/', 'GET')).toBe(true);
    expect(isPublicModePath('/api/poll', 'GET')).toBe(true);
    expect(isPublicModePath('/api/history', 'GET')).toBe(true);
  });

  test('writes and admin pages are not', () => {
    expect(isPublicModePath('/api/history', 'DELETE')).toBe(false);
    for (const path of [
      '/api/probe',
      '/api/errors',
      '/errors',
      '/api/ddns-log',
      '/ddns',
      '/api/cost',
      '/api/subscriptions',
      '/subscriptions',
      '/api/notification-settings',
      '/api/subscribe',
      '/api/unsubscribe',
      '/some-endpoint-added-later',
    ]) {
      expect(isPublicModePath(path, 'GET')).toBe(false);
      expect(isPublicModePath(path, 'POST')).toBe(false);
    }
  });
});

describe('the gate, through the worker', () => {
  const publicEnv = () => envFor({ ...secrets, PUBLIC_DASHBOARD: 'true' });

  test('an anonymous visitor sees the dashboard, without admin parts', async () => {
    const res = await fetchAs(publicEnv(), '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="viewer-public"');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('href="/errors"');
    expect(html).not.toContain('href="/ddns"');
    expect(html).not.toContain('id="notif-btn"');
    expect(html).toContain('const IS_ADMIN = false');
  });

  test('an admin sees the full dashboard and a Log out link', async () => {
    const env = publicEnv();
    const res = await fetchAs(env, '/', { cookie: await adminCookie(env) });
    const html = await res.text();
    expect(html).not.toContain('class="viewer-public"');
    expect(html).toContain('href="/errors"');
    expect(html).toContain('href="/logout"');
    expect(html).toContain('const IS_ADMIN = true');
  });

  test.each([
    ['GET', '/errors'],
    ['GET', '/api/errors'],
    ['GET', '/ddns'],
    ['GET', '/api/ddns-log'],
    ['GET', '/api/cost'],
    ['GET', '/subscriptions'],
    ['GET', '/api/subscriptions'],
    ['DELETE', '/api/subscriptions?id=1'],
    ['POST', '/api/notification-settings'],
    ['POST', '/api/probe'],
    ['DELETE', '/api/history?service=x'],
  ])('anonymous %s %s gets the login page, not the endpoint', async (method, path) => {
    const res = await fetchAs(publicEnv(), path, { method });
    expect(res.status).toBe(200);
    expect(await isLoginPage(res)).toBe(true);
  });

  test('public mode with no password 404s admin paths instead of opening them', async () => {
    const env = envFor({ PUBLIC_DASHBOARD: 'true' });
    expect((await fetchAs(env, '/api/subscriptions')).status).toBe(404);
    expect((await fetchAs(env, '/')).status).toBe(200);
  });

  test('the poll endpoint strips the DDNS log for anonymous visitors', async () => {
    sqlite.run(
      `INSERT INTO ddns_log (timestamp, hostname, event, old_ip, new_ip, status_code) VALUES (${Date.now()}, 'home.example', 'ip_change', '1.1.1.1', '2.2.2.2', 200)`,
    );
    const env = publicEnv();
    const anon = (await (await fetchAs(env, '/api/poll')).json()) as { ddnsLog: unknown[] };
    expect(anon.ddnsLog).toEqual([]);
    const admin = (await (await fetchAs(env, '/api/poll', { cookie: await adminCookie(env) })).json()) as {
      ddnsLog: unknown[];
    };
    expect(admin.ddnsLog.length).toBe(1);
  });

  test('gated mode (no PUBLIC_DASHBOARD) is unchanged: even / needs a login', async () => {
    const res = await fetchAs(envFor(secrets), '/');
    expect(await isLoginPage(res)).toBe(true);
  });

  test('/login redirects home when there is nothing to log into', async () => {
    const res = await fetchAs(envFor({ PUBLIC_DASHBOARD: 'true' }), '/login');
    expect(res.status).toBe(302);
  });

  test('/logout clears the cookie', async () => {
    const res = await fetchAs(publicEnv(), '/logout');
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('login throttling', () => {
  const login = (env: Env, passphrase: string, ip = '198.51.100.1') =>
    fetchAs(env, '/login', { method: 'POST', body: new URLSearchParams({ passphrase }), ip });

  test(`locks an IP out after ${LOGIN_MAX_FAILURES} failures, even for the right passphrase`, async () => {
    const env = envFor({ ...secrets, PUBLIC_DASHBOARD: 'true' });
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await login(env, 'wrong')).status).toBe(401);
    const locked = await login(env, PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Another IP is unaffected.
    expect((await login(env, PASSWORD, '198.51.100.2')).status).toBe(302);
  });

  test('a lockout costs no further writes', async () => {
    const db = d1(sqlite);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await recordLoginFailure(db, 'ip');
    const env = envFor({ ...secrets });
    await login(env, 'wrong', 'ip');
    const row = sqlite.query(`SELECT failures FROM login_attempts WHERE ip = 'ip'`).get() as { failures: number };
    expect(row.failures).toBe(LOGIN_MAX_FAILURES);
  });

  test('a successful login clears the count', async () => {
    const env = envFor({ ...secrets });
    await login(env, 'wrong');
    expect((await login(env, PASSWORD)).status).toBe(302);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM login_attempts`).get()).toEqual({ n: 0 });
  });

  test('the window lapses, and lapsed rows are swept', async () => {
    const db = d1(sqlite);
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await recordLoginFailure(db, 'ip', t0);
    expect(await loginRetryAfter(db, 'ip', t0 + 1000)).toBeGreaterThan(0);
    expect(await loginRetryAfter(db, 'ip', t0 + LOGIN_WINDOW_MS)).toBe(0);

    // A failure after the window restarts the count at 1 rather than adding to it.
    await recordLoginFailure(db, 'ip', t0 + LOGIN_WINDOW_MS);
    expect(sqlite.query(`SELECT failures FROM login_attempts`).get()).toEqual({ failures: 1 });

    await cleanupLoginAttempts(db, t0 + 3 * LOGIN_WINDOW_MS);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM login_attempts`).get()).toEqual({ n: 0 });
  });
});
