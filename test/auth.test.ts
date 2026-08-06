import { describe, expect, test } from 'bun:test';
import {
  assertAuthConfig,
  buildAuthCookie,
  getAuthCookie,
  isAuthEnabled,
  isPublicPath,
  issueToken,
  verifyPassword,
  verifyToken,
  verifyUsageToken,
} from '../src/auth';
import type { Env } from '../src/types';

const env = (o: Partial<Env>) => o as Env;
const configured = env({ DASHBOARD_PASSWORD: 'correct horse', AUTH_SECRET: 'signing-secret' });

describe('configuration', () => {
  test('auth is off until a password is set', () => {
    expect(isAuthEnabled(env({}))).toBe(false);
    expect(isAuthEnabled(configured)).toBe(true);
  });

  // A password with no signing secret cannot be made safe, so fail loudly
  // rather than quietly serving the dashboard unprotected.
  test('a password without a signing secret is a hard error', () => {
    expect(() => assertAuthConfig(env({ DASHBOARD_PASSWORD: 'x' }))).toThrow(/AUTH_SECRET/);
    expect(() => assertAuthConfig(configured)).not.toThrow();
    expect(() => assertAuthConfig(env({}))).not.toThrow();
  });
});

describe('password check', () => {
  test('accepts the configured password and rejects everything else', async () => {
    expect(await verifyPassword(configured, 'correct horse')).toBe(true);
    expect(await verifyPassword(configured, 'correct hors')).toBe(false);
    expect(await verifyPassword(configured, 'correct horse ')).toBe(false);
    expect(await verifyPassword(configured, '')).toBe(false);
  });

  test('never authenticates when no password is configured', async () => {
    expect(await verifyPassword(env({}), '')).toBe(false);
    expect(await verifyPassword(env({}), 'anything')).toBe(false);
  });
});

describe('session token', () => {
  test('a freshly issued token verifies', async () => {
    expect(await verifyToken(configured, await issueToken(configured))).toBe(true);
  });

  // The whole point of the rewrite: the stored secret must not be replayable
  // as a cookie, unlike the old scheme where the cookie WAS the password hash.
  test('the raw secret is not itself a valid token', async () => {
    expect(await verifyToken(configured, 'signing-secret')).toBe(false);
    expect(await verifyToken(configured, 'correct horse')).toBe(false);
  });

  test('rejects tampering with the expiry the signature covers', async () => {
    const token = await issueToken(configured);
    const [version, expiry, sig] = token.split('.');
    const extended = `${version}.${Number(expiry) + 86_400_000}.${sig}`;
    expect(await verifyToken(configured, extended)).toBe(false);
  });

  test('rejects a forged signature', async () => {
    const [version, expiry] = (await issueToken(configured)).split('.');
    expect(await verifyToken(configured, `${version}.${expiry}.aaaa`)).toBe(false);
  });

  test('rejects an expired token', async () => {
    const token = await issueToken(configured, Date.now() - 400 * 24 * 60 * 60 * 1000);
    expect(await verifyToken(configured, token)).toBe(false);
  });

  test('rejects a token signed with a different secret', async () => {
    const token = await issueToken(env({ DASHBOARD_PASSWORD: 'p', AUTH_SECRET: 'other-secret' }));
    expect(await verifyToken(configured, token)).toBe(false);
  });

  test('rejects malformed input without throwing', async () => {
    for (const bad of [null, '', 'a', 'a.b', 'a.b.c.d', 'v2.123.abc', '..']) {
      expect(await verifyToken(configured, bad)).toBe(false);
    }
  });
});

describe('cookie handling', () => {
  const req = (cookie: string) => new Request('https://example.com/', { headers: { Cookie: cookie } });

  test('extracts its own cookie from among others', () => {
    expect(getAuthCookie(req('theme=dark; uptime_auth=abc; other=1'))).toBe('abc');
    expect(getAuthCookie(req('uptime_auth=abc'))).toBe('abc');
  });

  test('returns null when absent', () => {
    expect(getAuthCookie(new Request('https://example.com/'))).toBe(null);
    expect(getAuthCookie(req('theme=dark'))).toBe(null);
    // Must not match a cookie whose name merely ends with ours.
    expect(getAuthCookie(req('not_uptime_auth=abc'))).toBe(null);
  });

  test('issued cookie is HttpOnly, SameSite, and Secure over https', async () => {
    const secure = await buildAuthCookie(configured, true);
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Strict');
    expect(secure).toContain('Secure');
    expect(await buildAuthCookie(configured, false)).not.toContain('Secure');
  });

  test('the issued cookie round-trips through verification', async () => {
    const value = (await buildAuthCookie(configured, true)).split(';')[0].replace('uptime_auth=', '');
    expect(await verifyToken(configured, value)).toBe(true);
  });
});

describe('public paths', () => {
  test('PWA assets and the login page bypass the session gate', () => {
    for (const p of ['/health', '/manifest.json', '/sw.js', '/icon-192.png', '/login']) {
      expect(isPublicPath(p)).toBe(true);
    }
  });

  test('everything else is gated', () => {
    for (const p of ['/', '/api/poll', '/errors', '/subscriptions', '/api/ddns-log']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});

describe('usage ingest token', () => {
  const request = (auth?: string) =>
    new Request('https://example.com/api/usage', { method: 'POST', headers: auth ? { Authorization: auth } : {} });

  // Cookie-exempt, but never open: this endpoint writes to the database.
  test('is cookie-exempt so reporting apps do not get a login page', () => {
    expect(isPublicPath('/api/usage')).toBe(true);
  });

  test('refuses with 503 when no token is configured', async () => {
    const res = await verifyUsageToken(env({}), request('Bearer anything'));
    expect(res?.status).toBe(503);
  });

  test('accepts the right bearer token', async () => {
    expect(await verifyUsageToken(env({ USAGE_TOKEN: 'tok' }), request('Bearer tok'))).toBe(null);
  });

  test('rejects a wrong, missing, or malformed token with 401', async () => {
    const e = env({ USAGE_TOKEN: 'tok' });
    expect((await verifyUsageToken(e, request('Bearer nope')))?.status).toBe(401);
    expect((await verifyUsageToken(e, request()))?.status).toBe(401);
    expect((await verifyUsageToken(e, request('tok')))?.status).toBe(401);
    expect((await verifyUsageToken(e, request('Basic tok')))?.status).toBe(401);
  });
});
