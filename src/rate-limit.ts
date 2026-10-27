/**
 * Per-IP request limiting for non-admins, through Cloudflare's `[[ratelimits]]`
 * binding. The limit itself (requests per 10 or 60 seconds) lives in the
 * deployer's wrangler.toml, not here.
 *
 * A public dashboard is the reason this exists. The Worker's daily limits are
 * shared by everything on the Cloudflare account, so one client looping on the
 * page could otherwise stop the monitor's own cron writes until 00:00 UTC (Free),
 * or run up usage charges (Paid).
 */

import type { Env } from './types';

/** Static assets, the health probe and the token-gated usage endpoint. None of
 *  them touch storage, and a browser fetches the assets in bursts. */
const UNMETERED_PATHS = new Set([
  '/manifest.json',
  '/sw.js',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.ico',
  '/robots.txt',
  '/health',
  '/api/usage',
]);

/** A 429 for a client over its limit, or null to carry on. Fails open: a
 *  missing binding, a request without a client IP, or an error from the binding
 *  all let the request through, since locking everyone out is worse. */
export async function rateLimitResponse(env: Env, request: Request, pathname: string): Promise<Response | null> {
  if (!env.RATE_LIMITER || UNMETERED_PATHS.has(pathname)) return null;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return null;
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (success) return null;
  } catch (err) {
    console.error('Rate limiter failed:', err instanceof Error ? err.message : err);
    return null;
  }
  return new Response('Too many requests. Try again in a minute.', {
    status: 429,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' },
  });
}
