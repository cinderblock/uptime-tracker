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
]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}
