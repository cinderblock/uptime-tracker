/**
 * Dashboard authentication.
 *
 * The cookie is an HMAC-signed token, NOT the password verifier — knowing the
 * stored value must not be enough to authenticate. Tokens carry an expiry that
 * is covered by the signature, so they can't be extended by the client.
 *
 *   token = "v1.<expiresAtMs>.<base64url(HMAC-SHA256(AUTH_SECRET, "v1.<expiresAtMs>"))>"
 *
 * Configuration (both are secrets — `wrangler secret put <NAME>`):
 *   DASHBOARD_PASSWORD — the shared passphrase. When unset the dashboard is public.
 *   AUTH_SECRET        — random string used to sign cookies. Required when
 *                        DASHBOARD_PASSWORD is set; rotating it logs everyone out.
 */

import { b64d, b64u } from './base64';
import type { Env } from './types';

const AUTH_COOKIE = 'uptime_auth';
const TOKEN_VERSION = 'v1';
const TOKEN_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

/** Is password protection turned on for this deployment? */
export function isAuthEnabled(env: Env): boolean {
  return Boolean(env.DASHBOARD_PASSWORD);
}

/**
 * Misconfiguration guard: a password without a signing secret can't be made
 * safe, so fail loudly instead of silently running unprotected.
 */
export function assertAuthConfig(env: Env): void {
  if (env.DASHBOARD_PASSWORD && !env.AUTH_SECRET) {
    throw new Error('DASHBOARD_PASSWORD is set but AUTH_SECRET is missing — run: wrangler secret put AUTH_SECRET');
  }
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

/** Constant-time comparison. Lengths are compared first — that much is public. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Compare a submitted passphrase against the configured one, in constant time. */
export async function verifyPassword(env: Env, submitted: string): Promise<boolean> {
  const expected = env.DASHBOARD_PASSWORD;
  if (!expected) return false;
  // Hash both sides first so the comparison operates on equal-length buffers
  // and never leaks the password's length through an early return.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(submitted)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

/** Does `submitted` match SUBSCRIBE_PASSWORD? True when no code is set:
 *  then anyone who can see the dashboard may subscribe. */
export async function verifySubscribeCode(env: Env, submitted: string | undefined): Promise<boolean> {
  const expected = env.SUBSCRIBE_PASSWORD;
  if (!expected) return true;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(submitted ?? '')),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

/** Mint a signed session token. */
export async function issueToken(env: Env, now: number = Date.now()): Promise<string> {
  assertAuthConfig(env);
  const payload = `${TOKEN_VERSION}.${now + TOKEN_MAX_AGE_MS}`;
  const sig = await hmac(env.AUTH_SECRET!, payload);
  return `${payload}.${b64u(sig)}`;
}

/** Verify a session token: signature valid AND not expired. */
export async function verifyToken(env: Env, token: string | null, now: number = Date.now()): Promise<boolean> {
  if (!token || !env.AUTH_SECRET) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [version, expiresAt, signature] = parts;
  if (version !== TOKEN_VERSION) return false;

  const expected = await hmac(env.AUTH_SECRET, `${version}.${expiresAt}`);
  let provided: Uint8Array;
  try {
    provided = b64d(signature);
  } catch {
    return false;
  }
  // Verify the signature BEFORE trusting the expiry it covers.
  if (!timingSafeEqual(expected, provided)) return false;

  const expiry = Number(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

/** Pull the auth cookie out of a request, if present. */
export function getAuthCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const cookie of header.split(';')) {
    const idx = cookie.indexOf('=');
    if (idx === -1) continue;
    if (cookie.slice(0, idx).trim() === AUTH_COOKIE) return cookie.slice(idx + 1).trim();
  }
  return null;
}

/** `Set-Cookie` value carrying a freshly minted token. */
export async function buildAuthCookie(env: Env, secure: boolean): Promise<string> {
  const token = await issueToken(env);
  const maxAge = Math.floor(TOKEN_MAX_AGE_MS / 1000);
  return `${AUTH_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict`;
}

/** Paths reachable without authentication (PWA assets + health probe). */
const PUBLIC_PATHS = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/health',
  '/manifest.json',
  '/sw.js',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/login',
  // Exempt from the session cookie, but NOT unauthenticated — it carries its
  // own bearer token. See verifyUsageToken and cost/push-handler.ts.
  '/api/usage',
]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

// ── Public mode ──────────────────────────────────────────────────────────────
//
// PUBLIC_DASHBOARD=true splits visitors in two. Anyone may read the status
// page; only a logged-in admin reaches everything else. This is an ALLOWLIST
// on purpose — an endpoint added later stays admin-only until someone decides
// otherwise, rather than leaking by default.

/** Is the read-only public view turned on? */
export function isPublicMode(env: Env): boolean {
  return env.PUBLIC_DASHBOARD === 'true';
}

/** Read-only paths a public-mode visitor may reach without logging in.
 *  Everything here must be safe to serve to anyone: handlers check `admin`
 *  and strip DDNS, cost and other admin-only data from the response. */
const PUBLIC_MODE_PATHS = new Set([
  '/',
  '/api/poll',
  // A device managing its own push subscription. Each handler authorises by
  // the device's endpoint (and, to subscribe, SUBSCRIBE_PASSWORD), and only
  // ever touches that one device. See subscribers.ts.
  '/api/subscribe',
  '/api/unsubscribe',
  '/api/notification-settings',
]);

/** GET-only additions: the same path also has an admin-only write method. */
const PUBLIC_MODE_GET_PATHS = new Set(['/api/history']);

export function isPublicModePath(pathname: string, method: string): boolean {
  if (PUBLIC_MODE_PATHS.has(pathname)) return true;
  return method === 'GET' && PUBLIC_MODE_GET_PATHS.has(pathname);
}

/**
 * Is this request from an admin?
 *
 * | PUBLIC_DASHBOARD | DASHBOARD_PASSWORD | Admin when                        |
 * | ---------------- | ------------------ | --------------------------------- |
 * | off              | unset              | always (fully open, as before)    |
 * | off              | set                | valid cookie (gated, as before)   |
 * | on               | set                | valid cookie                      |
 * | on               | unset              | never — no way to log in          |
 */
export async function isAdminRequest(env: Env, request: Request): Promise<boolean> {
  if (!isAuthEnabled(env)) return !isPublicMode(env);
  return verifyToken(env, getAuthCookie(request));
}

/** `Set-Cookie` value that clears the session. */
export function buildLogoutCookie(secure: boolean): string {
  return `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict`;
}

// ── Login throttling ─────────────────────────────────────────────────────────
//
// A shared passphrase on a public page will be guessed at. Failed attempts are
// counted per client IP in D1 (not KV: the free plan allows only 1,000 KV
// writes a day, and an attacker could burn them). Once an IP is locked out,
// further attempts are refused WITHOUT a write, so a flood costs one row.

export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Seconds until this IP may try again, or 0 if it may try now. */
export async function loginRetryAfter(db: D1Database | undefined, ip: string, now = Date.now()): Promise<number> {
  if (!db) return 0;
  const row = await db
    .prepare(`SELECT window_start, failures FROM login_attempts WHERE ip = ?`)
    .bind(ip)
    .first<{ window_start: number; failures: number }>();
  if (!row || now - row.window_start >= LOGIN_WINDOW_MS) return 0;
  if (row.failures < LOGIN_MAX_FAILURES) return 0;
  return Math.ceil((row.window_start + LOGIN_WINDOW_MS - now) / 1000);
}

/** Count one failed attempt, starting a fresh window if the old one lapsed. */
export async function recordLoginFailure(db: D1Database | undefined, ip: string, now = Date.now()): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO login_attempts (ip, window_start, failures) VALUES (?1, ?2, 1)
       ON CONFLICT(ip) DO UPDATE SET
         failures     = CASE WHEN ?2 - window_start >= ?3 THEN 1  ELSE failures + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
    )
    .bind(ip, now, LOGIN_WINDOW_MS)
    .run();
}

/** A successful login clears the IP's count. */
export async function clearLoginFailures(db: D1Database | undefined, ip: string): Promise<void> {
  if (!db) return;
  await db.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(ip).run();
}

/** Drop lapsed windows so the table can't grow without bound. */
export async function cleanupLoginAttempts(db: D1Database | undefined, now = Date.now()): Promise<void> {
  if (!db) return;
  await db
    .prepare(`DELETE FROM login_attempts WHERE window_start < ?`)
    .bind(now - LOGIN_WINDOW_MS)
    .run();
}

/**
 * Bearer-token check for the usage ingest endpoint.
 *
 * Returns null when authorised, or the Response to send back otherwise.
 * Refuses when unconfigured rather than defaulting to open — this endpoint
 * writes to the database.
 */
export async function verifyUsageToken(env: Env, request: Request): Promise<Response | null> {
  const expected = env.USAGE_TOKEN;
  if (!expected) {
    return new Response(JSON.stringify({ error: 'usage ingest not configured (set USAGE_TOKEN)' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const header = request.headers.get('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  if (!timingSafeEqual(new Uint8Array(a), new Uint8Array(b))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}
