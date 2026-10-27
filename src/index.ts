import type {
  Env,
  CheckResult,
  DashboardConfig,
  PanelStatus,
  ServiceStatus,
  PushUrgency,
  NotificationDisplayOptions,
  NotificationEventType,
  NotificationSettings,
  DdnsClient,
  LaneObservation,
  DashboardAccess,
  TransitionsState,
} from './types';
import {
  assertAuthConfig,
  buildAuthCookie,
  buildLogoutCookie,
  cleanupLoginAttempts,
  clearLoginFailures,
  isAdminRequest,
  isAuthEnabled,
  isPublicMode,
  isPublicModePath,
  isPublicPath,
  loginRetryAfter,
  recordLoginFailure,
  verifyPassword,
  verifyUsageToken,
} from './auth';
import { runAllChecks, runBudgetedChecks, parseConcurrency } from './checks';
import { ddnsCacheTtlSeconds, isNthTick, resolvePlan, type PlanProfile } from './plan';
import {
  saveCurrentStatus,
  getCurrentStatus,
  addToHistory,
  updateChartTiered,
  updateUptimeBuckets,
  cleanupHistory,
  getCheckHistory,
  getChartData,
  getMultiPeriodUptime,
  getRecentDdnsLog,
  getLatestDdnsSuccess,
  getDdnsIpChangesSince,
  refreshDdnsCache,
  cleanupDdnsLog,
  getRecentErrors,
  getLastCheckedTimes,
  deleteServiceHistory,
  addPushSubscription,
  removePushSubscription,
  removePushSubscriptionById,
  getAllPushSubscriptions,
  updateLastNotified,
  getNotificationSettings,
  setNotificationSettings,
  getAllNotificationSettings,
  getAllNotificationStates,
  getNotificationState,
  updateNotificationState,
  batchUpdateNotificationStates,
  addNotificationLogEntry,
  cleanupNotificationLog,
  getTransitions,
  updateTransitions,
} from './storage';
import { cleanupRollup, rollUpHourly } from './storage-free';
import { renderDashboard } from './ui';
import { sendPushNotification } from './push';
import { ICON_180_PNG, ICON_192_PNG, ICON_512_PNG } from './icons';
import { mergePricing } from './cost/pricing';
import {
  getPricingOverride,
  getCostByProvider,
  getHourlySamples,
  cleanupUsageLog,
  hourBucket,
  monthStartHourBucket,
  prevMonthStartHourBucket,
} from './cost/store';
import { pollCloudflareUsage } from './cost/cloudflare-poller';
import { handleUsagePost } from './cost/push-handler';
import { checkThresholds, alertNotificationContent, markThresholdsFired, getThresholdStatus } from './cost/thresholds';
import type { CostPanelData } from './cost/ui';

const STALE_THRESHOLD_MS = 60_000; // Auto-run checks in dev if data >1 min old

// ── PWA assets ────────────────────────────────────────────────────────────────

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="32" fill="#0d1117"/>
  <circle cx="96" cy="96" r="52" fill="none" stroke="#3fb950" stroke-width="10"/>
  <path d="M70 96l18 18 34-34" stroke="#3fb950" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

const MANIFEST_JSON = JSON.stringify({
  name: 'Uptime Monitor',
  short_name: 'Uptime',
  description: 'Real-time service availability monitoring dashboard',
  start_url: '/',
  display: 'standalone',
  background_color: '#0d1117',
  theme_color: '#161b22',
  orientation: 'portrait-primary',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  ],
});

/** Service worker JS — served at /sw.js. Handles caching and push notifications. */
const SW_JS = `
const CACHE = 'uptime-v1';
const PRECACHE = ['/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const { pathname } = new URL(e.request.url);
  // Network-only for API and auth routes
  if (pathname.startsWith('/api/') || pathname === '/login') return;
  e.respondWith(
    (async () => {
      try {
        const response = await fetch(e.request);
        if (response.ok) {
          const c = await caches.open(CACHE);
          c.put(e.request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(e.request);
        return cached ?? new Response('Offline', { status: 503 });
      }
    })(),
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* non-JSON payload */ }
  e.waitUntil(
    self.registration.showNotification(data.title ?? 'Uptime Monitor', {
      body: data.body ?? 'Service status changed',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag ?? 'uptime',
      data: { url: data.url ?? '/' },
      silent: data.silent ?? false,
      requireInteraction: data.requireInteraction ?? false,
      renotify: data.renotify ?? false,
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url ? e.notification.data.url : '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const w of list) {
        if (w.url.includes(url) && 'focus' in w) return w.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
`.trim();

/** In dev mode (localhost), auto-run checks if data is stale or missing */
async function ensureFreshData(config: DashboardConfig, request: Request, env: Env, plan: PlanProfile): Promise<void> {
  const hostname = new URL(request.url).hostname;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return;

  const cached = await getCurrentStatus(plan, env.KV, env.DB);
  if (cached?.lastUpdate && Date.now() - cached.lastUpdate < STALE_THRESHOLD_MS) return;

  console.log('[dev] Data stale or missing, running checks...');
  const panels = await runAllChecks(config, 'edge');

  const allResults: CheckResult[] = [];
  for (const panel of panels) {
    for (const service of panel.services) {
      allResults.push(...service.checks);
      if (service.wwwCheck) allResults.push(service.wwwCheck);
    }
  }
  await addToHistory(env.DB, allResults);

  // Build last-checked times from fresh results
  const lastCheckedTimes = new Map<string, number>();
  for (const r of allResults) {
    const existing = lastCheckedTimes.get(r.service);
    if (!existing || r.timestamp > existing) {
      lastCheckedTimes.set(r.service, r.timestamp);
    }
  }
  await saveCurrentStatus(plan, env.KV, env.DB, panels, lastCheckedTimes);
  await updateChartTiered(plan, env.KV, env.DB, allResults);
  await updateUptimeBuckets(plan, env.KV, env.DB, allResults);
  if (plan.aggregateStore === 'd1') await rollUpHourly(env.DB, allResults, plan.historyRetentionDays);
  console.log(`[dev] Completed ${allResults.length} checks`);
}

/** Escape HTML special characters */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Render the login page */
function renderLoginPage(error?: string, status?: number, headers?: Record<string, string>): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Uptime Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117; color: #c9d1d9;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .login-box {
      background: #161b22; border: 1px solid #30363d; border-radius: 0.5rem;
      padding: 2rem; width: 100%; max-width: 320px;
    }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; text-align: center; }
    input {
      width: 100%; padding: 0.75rem; margin-bottom: 1rem;
      background: #0d1117; border: 1px solid #30363d; border-radius: 0.25rem;
      color: #c9d1d9; font-size: 1rem;
    }
    input:focus { outline: none; border-color: #58a6ff; }
    button {
      width: 100%; padding: 0.75rem; background: #238636; border: none;
      border-radius: 0.25rem; color: #fff; font-size: 1rem; cursor: pointer;
    }
    button:hover { background: #2ea043; }
    .error { color: #f85149; font-size: 0.875rem; margin-bottom: 1rem; text-align: center; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Uptime Monitor</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="password" name="passphrase" placeholder="Passphrase" autofocus required>
      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: status ?? (error ? 401 : 200),
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

/** Options for {@link createWorker}. */
export interface WorkerOptions {
  /** Panels, services, labels, providers and flags to monitor and render. */
  config: DashboardConfig;
  /** Dynamic-DNS clients to watch. Omit for none. */
  ddnsClients?: DdnsClient[];
}

/**
 * Build a Workers handler bound to `options`.
 *
 * This is the library entry point. A consumer owns its own `wrangler.toml` and
 * config module, imports this, and does `export default createWorker({ config })`.
 * Nothing has to exist inside *this* package's tree for that to work, which is
 * precisely what lets it be vendored as a git submodule with no copy-in step —
 * a parent repo cannot track files inside a submodule's working tree.
 *
 * `src/worker.ts` is the standalone equivalent, for deploying this repo directly.
 */
export function createWorker({ config, ddnsClients = [] }: WorkerOptions): ExportedHandler<Env> {
  return {
    /** HTTP request handler */
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      // Pure and cheap (a lookup plus a few env parses) — resolving it per
      // request keeps the read path from having to guess which storage backend
      // the cron is writing to.
      const plan = resolvePlan(env);

      // Dev mode: auto-run checks in background if data is stale (non-blocking)
      ctx.waitUntil(ensureFreshData(config, request, env, plan));

      // Fail loudly on a half-configured auth setup rather than serving unprotected.
      assertAuthConfig(env);

      // Handle login form submission
      if (url.pathname === '/login' && request.method === 'POST') {
        if (!isAuthEnabled(env)) {
          return new Response('Authentication is not configured on this deployment.', { status: 404 });
        }

        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const retryAfter = await loginRetryAfter(env.DB, ip);
        if (retryAfter > 0) {
          return renderLoginPage(`Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} min.`, 429, {
            'Retry-After': String(retryAfter),
          });
        }

        const formData = await request.formData();
        const passphrase = formData.get('passphrase') as string;

        if (!passphrase) {
          return renderLoginPage('Please enter a passphrase');
        }

        if (!(await verifyPassword(env, passphrase))) {
          await recordLoginFailure(env.DB, ip);
          return renderLoginPage('Invalid passphrase');
        }

        await clearLoginFailures(env.DB, ip);
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/',
            'Set-Cookie': await buildAuthCookie(env, url.protocol === 'https:'),
          },
        });
      }

      if (url.pathname === '/logout') {
        return new Response(null, {
          status: 302,
          headers: { Location: '/', 'Set-Cookie': buildLogoutCookie(url.protocol === 'https:') },
        });
      }

      // Gate everything except static assets, the health probe, and the login
      // page — and, in public mode, the read-only status view. With neither a
      // password nor public mode, everyone is admin (the original open mode).
      const admin = await isAdminRequest(env, request);
      const publicMode = isPublicMode(env);
      if (url.pathname === '/login') {
        // An explicit visit to the login page (the public view's Admin link).
        if (admin || !isAuthEnabled(env)) return Response.redirect(new URL('/', url).toString(), 302);
        return renderLoginPage();
      }
      if (!admin && !isPublicPath(url.pathname) && !(publicMode && isPublicModePath(url.pathname, request.method))) {
        if (isAuthEnabled(env)) return renderLoginPage();
        return new Response('Not Found', { status: 404 });
      }
      // Offer an Admin link (public mode) or Log out only where a password exists.
      const access: DashboardAccess = { admin, loginAvailable: isAuthEnabled(env) };

      try {
        switch (url.pathname) {
          case '/':
            return handleDashboard(config, env, plan, access);

          case '/manifest.json':
            return new Response(MANIFEST_JSON, {
              headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' },
            });

          case '/sw.js':
            return new Response(SW_JS, {
              headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
            });

          case '/icon.svg':
            return new Response(ICON_SVG, {
              headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
            });

          case '/icon-180.png':
            return new Response(ICON_180_PNG, {
              headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
            });

          case '/icon-192.png':
            return new Response(ICON_192_PNG, {
              headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
            });

          case '/icon-512.png':
            return new Response(ICON_512_PNG, {
              headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
            });

          case '/api/poll':
            return handleApiPoll(config, request, env, plan, admin);

          case '/api/history':
            if (request.method === 'DELETE') return handleDeleteHistory(request, env);
            return handleApiHistory(request, env);

          case '/api/probe':
            // Browser submitting check results
            return handleApiProbe(request, env, ctx);

          case '/api/usage': {
            // Cookie-exempt (reporting apps aren't browsers) but token-gated.
            const denied = await verifyUsageToken(env, request);
            return denied ?? handleApiUsage(request, env);
          }

          case '/api/cost':
            return handleApiCost(env);

          case '/api/errors':
            return handleApiErrors(url, env);

          case '/api/ddns-log':
            return handleApiDdnsLog(url, env, plan);

          case '/api/subscribe':
            return handleApiSubscribe(request, env);

          case '/api/unsubscribe':
            return handleApiUnsubscribe(request, env);

          case '/api/notification-settings':
            return handleApiNotificationSettings(request, env);

          case '/api/subscriptions':
            return handleApiSubscriptions(request, env);

          case '/errors':
            return handleErrorsPage(url, env);

          case '/ddns':
            return handleDdnsPage(url, env, plan);

          case '/subscriptions':
            return handleSubscriptionsPage(env);

          case '/health':
            return new Response('ok', { status: 200 });

          case '/favicon.ico':
          case '/robots.txt':
            return new Response(null, { status: 204 });

          default:
            return new Response('Not Found', { status: 404 });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Request error:', error.message);
        console.error('Stack:', error.stack);

        // Detailed error page for debugging, admins only. A public-mode visitor
        // gets a bare 500, since a stack trace can name internals.
        if (!admin) return new Response('Internal Server Error', { status: 500 });
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Uptime Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0d1117; color: #c9d1d9; padding: 2rem;
    }
    h1 { color: #f85149; margin-bottom: 1rem; }
    h2 { color: #c9d1d9; margin-bottom: 1rem; font-weight: normal; }
    pre {
      background: #161b22; padding: 1rem; border-radius: 0.5rem;
      overflow-x: auto; border: 1px solid #30363d;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 0.875rem; line-height: 1.5;
    }
  </style>
</head>
<body>
  <h1>Worker Error</h1>
  <h2>${escapeHtml(error.message)}</h2>
  <pre>${escapeHtml(error.stack || 'No stack trace available')}</pre>
</body>
</html>`;

        return new Response(html, {
          status: 500,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    },

    /** Scheduled cron handler.
     *
     *  The first argument is a `ScheduledController` (`scheduledTime`, `cron`,
     *  `noRetry()`), NOT a `ScheduledEvent` — it was annotated as the latter
     *  until `createWorker` gave the handler an `ExportedHandler<Env>` to be
     *  checked against. Only `scheduledTime` is read, which both types carry,
     *  so this was a wrong annotation rather than a runtime fault. Note a
     *  controller has no `waitUntil` — use `ctx.waitUntil`. */
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      try {
        const plan = resolvePlan(env);
        console.log(`Running scheduled checks (plan: ${plan.tier})...`);

        // Load last-checked times, notification settings, and prior status in parallel.
        // `cached` doubles as (1) input to the retry-on-timeout map (so a glitch
        // after a prior 'up' triggers one retry) and (2) the merge baseline for
        // services we don't have budget to recheck this tick.
        const [lastCheckedTimes, allNotifSettings, cached] = await Promise.all([
          getLastCheckedTimes(plan, env.KV, env.DB),
          getAllNotificationSettings(env.DB),
          getCurrentStatus(plan, env.KV, env.DB),
        ]);

        // Services with notifications enabled get checked first
        const priorityKeys = new Set(
          Object.entries(allNotifSettings)
            .filter(([, s]) => s.enabled)
            .map(([key]) => key),
        );

        // URL → most recent CheckResult, threaded through runBudgetedChecks so
        // runHttpCheck/runWwwCheck can decide whether a timeout warrants a retry.
        const previousResults = new Map<string, CheckResult>();
        for (const panel of cached?.panels ?? []) {
          for (const service of panel.services) {
            for (const check of service.checks) previousResults.set(check.url, check);
            if (service.wwwCheck) previousResults.set(service.wwwCheck.url, service.wwwCheck);
          }
        }

        // Run budget-aware checks (priority services first, then by staleness)
        const concurrency = parseConcurrency(env.CHECK_CONCURRENCY ?? plan.checkConcurrency);
        const freshResults = await runBudgetedChecks(
          config,
          lastCheckedTimes,
          'edge',
          priorityKeys,
          concurrency,
          previousResults,
          plan.checkBudget,
        );

        // Merge fresh results with cached status (unchecked services keep previous state)
        const panels = buildMergedStatus(config, freshResults, cached);

        // Save only fresh check results to history
        const allResults: CheckResult[] = [];
        for (const { checks, wwwCheck } of freshResults.values()) {
          allResults.push(...checks);
          if (wwwCheck) allResults.push(wwwCheck);
        }
        await addToHistory(env.DB, allResults);
        console.log(`Saved ${allResults.length} check results to history`);

        // Paid: incrementally update the durable chart + uptime KV state so the
        // read path stays D1-free. Worst-of-bucket merge for chart, sum counters
        // for uptime; both run in a few ms and replace the prior hourly D1 scans.
        // First call after deploy self-backfills from D1 (one-time ~$0.01).
        //
        // Free: those two are no-ops (the blobs are far too large to touch under
        // a 10 ms CPU limit) and `rollUpHourly` maintains the D1 `uptime_hourly`
        // table instead — one UPSERT per service per hour, read back on demand.
        await Promise.all([
          updateChartTiered(plan, env.KV, env.DB, allResults),
          updateUptimeBuckets(plan, env.KV, env.DB, allResults),
          plan.aggregateStore === 'd1'
            ? rollUpHourly(env.DB, allResults, plan.historyRetentionDays)
            : Promise.resolve(),
        ]);

        // Update last-checked times with fresh results, then save status + times to KV (single write)
        for (const r of allResults) {
          const existing = lastCheckedTimes.get(r.service);
          if (!existing || r.timestamp > existing) {
            lastCheckedTimes.set(r.service, r.timestamp);
          }
        }
        await saveCurrentStatus(plan, env.KV, env.DB, panels, lastCheckedTimes);

        const scheduled = new Date(controller.scheduledTime);
        const minuteOfDay = scheduled.getUTCHours() * 60 + scheduled.getUTCMinutes();

        // DDNS log is small (LIMIT 200 + indexed). The cache TTL is derived from
        // the cron interval — if it lapses, every dashboard request falls back to
        // a 200-row D1 query.
        ctx.waitUntil(refreshDdnsCache(plan, env.KV, env.DB, ddnsCacheTtlSeconds(plan)));

        // Detect services that newly transitioned to 'down' and send push notifications
        ctx.waitUntil(sendDowntimeNotifications(panels, env));

        // Detect DDNS staleness (heartbeat clients) and send push notifications
        ctx.waitUntil(sendDdnsFailureNotifications(ddnsClients, env));

        // Notify on actual DDNS IP changes (any client)
        ctx.waitUntil(sendDdnsIpChangeNotifications(env));

        // Detect GitHub build failures and send push notifications
        ctx.waitUntil(sendBuildFailureNotifications(config, env));

        // Record state flips for the correlation timeline (services + GitHub + DDNS).
        // Wrapped so a GitHub API hiccup can't fail the scheduled handler.
        ctx.waitUntil(
          recordTransitions(config, ddnsClients, env, plan, panels, Date.now()).catch(err =>
            console.error('recordTransitions failed:', err instanceof Error ? err.message : err),
          ),
        );

        // Cost monitor: poll CF GraphQL Analytics for the previous full hour at
        // :01 each hour (waits one minute past the hourly boundary so CF's
        // analytics ingestion has settled). Wrapped to never throw into the
        // outer scheduled handler — a cost-tracking failure must NOT take down
        // uptime monitoring.
        if (isNthTick(minuteOfDay, plan, plan.costPollEveryTicks)) {
          ctx.waitUntil(pollCloudflareUsageSafely(env));
        }

        // Threshold checks cost 2 KV reads + 5 D1 SUMs. Cheap on paid (every
        // tick); rate-limited on free, where those reads are metered.
        if (isNthTick(minuteOfDay, plan, plan.costCheckEveryTicks)) {
          ctx.waitUntil(checkAndFireThresholdAlerts(env));
        }

        // Clean up old entries periodically. Deletes count as D1 rows written,
        // so the cadence is part of the plan budget.
        if (isNthTick(minuteOfDay, plan, plan.cleanupEveryTicks)) {
          const deleted = await cleanupHistory(env.DB, plan.historyRetentionDays);
          if (deleted > 0) console.log(`Cleaned up ${deleted} old history entries`);

          // Free only: the hourly rollup ages out on the same window as `checks`.
          if (plan.aggregateStore === 'd1') {
            const rollupDeleted = await cleanupRollup(env.DB, plan.historyRetentionDays);
            if (rollupDeleted > 0) console.log(`Cleaned up ${rollupDeleted} old hourly rollup rows`);
          }

          const ddnsDeleted = await cleanupDdnsLog(env.DB);
          if (ddnsDeleted > 0) console.log(`Cleaned up ${ddnsDeleted} old DDNS log entries`);

          const notifLogDeleted = await cleanupNotificationLog(env.DB);
          if (notifLogDeleted > 0) console.log(`Cleaned up ${notifLogDeleted} old notification log entries`);

          const usageDeleted = await cleanupUsageLog(env.DB);
          if (usageDeleted > 0) console.log(`Cleaned up ${usageDeleted} old usage_log entries`);

          await cleanupLoginAttempts(env.DB);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Scheduled task error:', error.message);
        console.error('Stack:', error.stack);
        throw error; // Re-throw so Cloudflare logs it
      }
    },
  };
}

/** Send push notifications to all subscribers, removing expired ones.
 *  Returns delivery result with subscriber count and whether any were delivered. */
async function sendNotifications(
  db: Env['DB'],
  vapid: { publicKey: string; privateKey: string; subject: string },
  data: Record<string, unknown>,
  options?: NotificationDisplayOptions,
): Promise<{ delivered: boolean; subscriberCount: number }> {
  const subscriptions = await getAllPushSubscriptions(db);
  if (subscriptions.length === 0) return { delivered: false, subscriberCount: 0 };

  // Merge display options into payload for the service worker
  const payload = options ? { ...data, silent: options.silent, requireInteraction: options.requireInteraction } : data;

  let anyDelivered = false;
  for (const sub of subscriptions) {
    const result = await sendPushNotification(sub.endpoint, sub.p256dh, sub.auth, payload, vapid, options?.urgency);
    if (result.ok) {
      anyDelivered = true;
      await updateLastNotified(db, sub.endpoint);
    } else {
      const truncated = sub.endpoint.slice(0, 60) + '…';
      console.error(`Push failed for ${truncated}: status=${result.status} error=${result.error}`);
      if (result.status === 404 || result.status === 410) {
        await removePushSubscription(db, sub.endpoint);
        console.log(`Removed expired push subscription: ${truncated}`);
      }
    }
  }
  return { delivered: anyDelivered, subscriberCount: subscriptions.length };
}

/** Get VAPID config from env, or return null with a warning if incomplete. */
function getVapid(env: Env): { publicKey: string; privateKey: string; subject: string } | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    if (env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY) {
      console.warn('Push notifications require VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT to all be set');
    }
    return null;
  }
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
}

// ── Notification urgency / display options ────────────────────────────────────

const URGENCY_DEFAULTS: Record<NotificationEventType, NotificationDisplayOptions> = {
  'service-down': { urgency: 'high', requireInteraction: true, silent: false },
  'service-recovery': { urgency: 'normal', requireInteraction: false, silent: false },
  'build-failed': { urgency: 'normal', requireInteraction: false, silent: false },
  'build-recovery': { urgency: 'low', requireInteraction: false, silent: true },
  'ddns-failure': { urgency: 'high', requireInteraction: true, silent: false },
  'ddns-recovery': { urgency: 'low', requireInteraction: false, silent: false },
  'ddns-ip-change': { urgency: 'normal', requireInteraction: false, silent: false },
  'usage-threshold': { urgency: 'high', requireInteraction: true, silent: false },
  'usage-reconcile': { urgency: 'normal', requireInteraction: false, silent: false },
};

const URGENCY_LEVELS: PushUrgency[] = ['very-low', 'low', 'normal', 'high'];

/** Derive a recovery urgency one level below the down urgency */
function deriveRecoveryUrgency(downUrgency: PushUrgency): PushUrgency {
  return URGENCY_LEVELS[Math.max(0, URGENCY_LEVELS.indexOf(downUrgency) - 1)];
}

/** Resolve notification display options from event type + optional user override.
 *  For recovery events, urgency is derived one level below the user's down urgency. */
function resolveNotificationOptions(
  eventType: NotificationEventType,
  userUrgency: PushUrgency | null,
): NotificationDisplayOptions {
  const defaults = URGENCY_DEFAULTS[eventType];
  if (!userUrgency) return defaults;

  const isRecovery = eventType.endsWith('-recovery');
  const effectiveUrgency = isRecovery ? deriveRecoveryUrgency(userUrgency) : userUrgency;

  return {
    ...defaults,
    urgency: effectiveUrgency,
    // Recovery at low/very-low urgency should be silent
    ...(isRecovery && URGENCY_LEVELS.indexOf(effectiveUrgency) <= 1 ? { silent: true } : {}),
  };
}

/** Pick the highest urgency override among a set of notification keys */
function maxUrgencyOf(
  keys: string[],
  allSettings: Record<string, { urgency?: PushUrgency | null }>,
): PushUrgency | null {
  let max: PushUrgency | null = null;
  for (const key of keys) {
    const u = allSettings[key]?.urgency;
    if (!u) continue;
    if (!max || URGENCY_LEVELS.indexOf(u) > URGENCY_LEVELS.indexOf(max)) max = u;
  }
  return max;
}

/** Detect service up/down transitions and send push notifications respecting per-service settings. */
async function sendDowntimeNotifications(newPanels: PanelStatus[], env: Env): Promise<void> {
  const vapid = getVapid(env);
  if (!vapid) return;

  // Load all notification settings and states once
  const allSettings = await getAllNotificationSettings(env.DB);
  const allStates = await getAllNotificationStates(env.DB);

  const newlyDown: { name: string; key: string }[] = []; // services that just crossed their threshold
  const alreadyDown: string[] = []; // services previously notified and still down
  const recovered: { name: string; key: string }[] = [];
  const stateUpdates: { key: string; consecutiveDown: number; notifiedDown: number }[] = [];

  for (const panel of newPanels) {
    for (const svc of panel.services) {
      if (svc.knownStatus === 'known-down') continue;
      const key = svc.host ?? svc.name;
      const settings = allSettings[key] ?? { enabled: 0, failure_threshold: 1, notify_recovery: 0, urgency: null };
      const state = allStates[key] ?? { consecutive_down: 0, notified_down: 0 };

      if (!settings.enabled) {
        // Still update state so thresholds stay accurate when re-enabled
        if (svc.status === 'down') {
          stateUpdates.push({ key, consecutiveDown: state.consecutive_down + 1, notifiedDown: state.notified_down });
        } else if (state.consecutive_down > 0) {
          stateUpdates.push({ key, consecutiveDown: 0, notifiedDown: 0 });
        }
        continue;
      }

      if (svc.status === 'down') {
        const newCount = state.consecutive_down + 1;
        if (newCount >= settings.failure_threshold && !state.notified_down) {
          newlyDown.push({ name: svc.name, key });
          // Don't set notified_down yet — wait until delivery succeeds
          stateUpdates.push({ key, consecutiveDown: newCount, notifiedDown: 0 });
        } else {
          if (state.notified_down) alreadyDown.push(svc.name);
          stateUpdates.push({ key, consecutiveDown: newCount, notifiedDown: state.notified_down });
        }
      } else {
        // Service is up
        if (state.notified_down && settings.notify_recovery) {
          recovered.push({ name: svc.name, key });
        }
        if (state.consecutive_down > 0 || state.notified_down) {
          stateUpdates.push({ key, consecutiveDown: 0, notifiedDown: 0 });
        }
      }
    }
  }

  // Batch-write all state changes in a single transaction
  await batchUpdateNotificationStates(env.DB, stateUpdates);

  if (newlyDown.length > 0) {
    // Include all currently-down services in the body so the notification
    // (which replaces any previous one via the fixed tag) stays complete.
    const allDownNames = [...newlyDown.map(s => s.name), ...alreadyDown];
    const title = allDownNames.length === 1 ? '🔴 Service Down' : `🔴 ${allDownNames.length} Services Down`;
    const body = allDownNames.join(', ');
    // Use highest urgency among newly-down services
    const options = resolveNotificationOptions(
      'service-down',
      maxUrgencyOf(
        newlyDown.map(s => s.key),
        allSettings,
      ),
    );
    console.log(`Sending downtime notifications (urgency=${options.urgency}): ${body}`);
    const result = await sendNotifications(env.DB, vapid, { title, body, tag: 'service-down', url: '/' }, options);
    // Log one entry per service that triggered this notification
    for (const s of newlyDown) {
      await addNotificationLogEntry(env.DB, {
        key: s.key,
        type: 'service-down',
        title,
        body,
        urgency: options.urgency,
        subscribersNotified: result.subscriberCount,
        delivered: result.delivered,
      });
    }
    if (result.delivered) {
      // Mark notified_down only after successful delivery
      await batchUpdateNotificationStates(
        env.DB,
        newlyDown.map(s => ({
          key: s.key,
          consecutiveDown: (allStates[s.key]?.consecutive_down ?? 0) + 1,
          notifiedDown: 1,
        })),
      );
    }
  }

  if (recovered.length > 0) {
    const title = recovered.length === 1 ? '🟢 Service Recovered' : `🟢 ${recovered.length} Services Recovered`;
    const body = recovered.map(s => s.name).join(', ');
    const options = resolveNotificationOptions(
      'service-recovery',
      maxUrgencyOf(
        recovered.map(s => s.key),
        allSettings,
      ),
    );
    console.log(`Sending recovery notifications (urgency=${options.urgency}): ${body}`);
    const result = await sendNotifications(env.DB, vapid, { title, body, tag: 'service-recovery', url: '/' }, options);
    for (const s of recovered) {
      await addNotificationLogEntry(env.DB, {
        key: s.key,
        type: 'service-recovery',
        title,
        body,
        urgency: options.urgency,
        subscribersNotified: result.subscriberCount,
        delivered: result.delivered,
      });
    }
  }
}

/** How long a DDNS client may go silent before we alert. Clients (UniFi
 *  gateways with built-in Dynamic DNS) check in roughly every 20 min, so 1h is
 *  ~3 missed beats — useful without flapping on a single missed update. */
const DDNS_STALE_MS = 60 * 60 * 1000;

/** Watch each expected DDNS client for silence and send push notifications.
 *  The real failure signal is the *absence* of a recent success, not a
 *  scanner-driven 'rejected' row — so we alert on staleness of the last
 *  no_change/ip_change per hostname. User-facing settings are shared under the
 *  'ddns' key; runtime down/recovery state is tracked per hostname under
 *  `ddns:<hostname>`. */
async function sendDdnsFailureNotifications(ddnsClients: DdnsClient[], env: Env): Promise<void> {
  const vapid = getVapid(env);
  if (!vapid) return;

  const settings = await getNotificationSettings(env.DB, 'ddns');
  if (!settings.enabled) return;

  const now = Date.now();
  for (const client of ddnsClients) {
    // Only clients that heartbeat can be staleness-monitored. A silent-by-design
    // client (ddclient/USG) would otherwise false-alarm; its IP changes are
    // covered by sendDdnsIpChangeNotifications instead.
    if (!client.heartbeat) continue;
    try {
      await checkDdnsClientHealth(env, vapid, settings, client, now);
    } catch (err) {
      console.error(`DDNS health check failed for ${client.hostname}:`, err);
    }
  }
}

/** Notify on actual DDNS IP changes (any hostname). An `ip_change` event only
 *  happens when an authenticated client updates a record to a new IP, so these
 *  are always real and worth surfacing — and they're how we still catch a
 *  silent-by-design client (home/ddclient) doing something meaningful.
 *  notification_state.consecutive_down is repurposed as the last-notified
 *  ip_change id; migration 0008 seeds it past existing rows so we only alert on
 *  changes after deploy. */
async function sendDdnsIpChangeNotifications(env: Env): Promise<void> {
  const vapid = getVapid(env);
  if (!vapid) return;

  const settings = await getNotificationSettings(env.DB, 'ddns');
  if (!settings.enabled) return;

  const KEY = 'ddns:ip-change';
  const state = await getNotificationState(env.DB, KEY);
  const cursor = state.consecutive_down; // repurposed: last-notified ip_change id
  const changes = await getDdnsIpChangesSince(env.DB, cursor);
  if (changes.length === 0) return;

  for (const ev of changes) {
    const title = '🔁 DDNS IP Changed';
    const body = `${ev.hostname ?? 'unknown'}: ${ev.old_ip ?? '?'} → ${ev.new_ip ?? '?'}`;
    const options = resolveNotificationOptions('ddns-ip-change', settings.urgency);
    console.log(`Sending DDNS ip-change notification: ${body}`);
    const result = await sendNotifications(
      env.DB,
      vapid,
      { title, body, tag: 'ddns-ip-change', url: '/ddns' },
      options,
    );
    await addNotificationLogEntry(env.DB, {
      key: KEY,
      type: 'ddns-ip-change',
      title,
      body,
      urgency: options.urgency,
      subscribersNotified: result.subscriberCount,
      delivered: result.delivered,
    });
  }

  const maxId = changes.reduce((m, c) => Math.max(m, c.id), cursor);
  await updateNotificationState(env.DB, KEY, maxId, 0);
}

async function checkDdnsClientHealth(
  env: Env,
  vapid: { publicKey: string; privateKey: string; subject: string },
  settings: NotificationSettings,
  client: DdnsClient,
  now: number,
): Promise<void> {
  const key = `ddns:${client.hostname}`;
  const state = await getNotificationState(env.DB, key);
  const lastSuccess = await getLatestDdnsSuccess(env.DB, client.hostname);
  const isStale = lastSuccess === null || now - lastSuccess > DDNS_STALE_MS;

  if (isStale) {
    if (state.notified_down) return; // already alerted for this outage
    const detail = lastSuccess ? `last checked in ${formatDuration(now - lastSuccess)} ago` : 'has never checked in';
    const title = '⚠️ DDNS Stale';
    const body = `${client.label} (${client.hostname}) ${detail}`;
    const options = resolveNotificationOptions('ddns-failure', settings.urgency);
    console.log(`Sending DDNS stale notification (urgency=${options.urgency}): ${client.hostname} ${detail}`);
    const result = await sendNotifications(env.DB, vapid, { title, body, tag: key, url: '/ddns' }, options);
    await addNotificationLogEntry(env.DB, {
      key,
      type: 'ddns-failure',
      title,
      body,
      urgency: options.urgency,
      subscribersNotified: result.subscriberCount,
      delivered: result.delivered,
    });
    await updateNotificationState(env.DB, key, 0, result.delivered ? 1 : 0);
    return;
  }

  // Healthy: clear state and send recovery if we were previously alerting.
  if (state.notified_down) {
    if (settings.notify_recovery) {
      const title = '🟢 DDNS Recovered';
      const body = `${client.label} (${client.hostname}) is checking in again`;
      const options = resolveNotificationOptions('ddns-recovery', settings.urgency);
      console.log(`Sending DDNS recovery notification: ${client.hostname}`);
      const result = await sendNotifications(env.DB, vapid, { title, body, tag: key, url: '/ddns' }, options);
      await addNotificationLogEntry(env.DB, {
        key,
        type: 'ddns-recovery',
        title,
        body,
        urgency: options.urgency,
        subscribersNotified: result.subscriberCount,
        delivered: result.delivered,
      });
    }
    await updateNotificationState(env.DB, key, 0, 0);
  }
}

/** Compact human duration: "45m", "3h 12m", "2d 4h". */
function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const remMins = mins % 60;
    return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/** GitHub workflow run status from the API */
interface GitHubRunStatus {
  status: string;
  conclusion: string | null;
  id: number;
}

/** In-memory cache for GitHub workflow statuses to avoid redundant API calls.
 *  Each entry stores the result + timestamp so we can skip re-fetching within a window.
 *  TODO: entries are never evicted — add max-size cap if workflow count grows significantly */
const ghStatusCache = new Map<string, { result: GitHubRunStatus; fetchedAt: number }>();
const GH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Fetch the latest completed run status for a GitHub workflow (with in-memory cache). */
async function fetchGitHubWorkflowStatus(
  owner: string,
  repo: string,
  workflow: string,
  token?: string,
): Promise<GitHubRunStatus | null> {
  const cacheKey = `${owner}/${repo}/${workflow}`;
  const cached = ghStatusCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < GH_CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=1&status=completed`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'uptime-monitor',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return null;

    const data = (await res.json()) as { workflow_runs?: { id: number; status: string; conclusion: string | null }[] };
    const run = data.workflow_runs?.[0];
    if (!run) return null;
    const result: GitHubRunStatus = { status: run.status, conclusion: run.conclusion, id: run.id };
    ghStatusCache.set(cacheKey, { result, fetchedAt: Date.now() });
    return result;
  } catch {
    return null;
  }
}

/** Detect GitHub workflow failures and send push notifications.
 *  Only polls workflows that have notifications enabled.
 *  Uses run ID in notification_state.consecutive_down to avoid re-notifying
 *  for the same run across scheduler cycles. */
async function sendBuildFailureNotifications(config: DashboardConfig, env: Env): Promise<void> {
  const vapid = getVapid(env);
  if (!vapid) return;

  const workflows = config.githubWorkflows ?? [];
  if (workflows.length === 0) return;

  const allSettings = await getAllNotificationSettings(env.DB);
  const allStates = await getAllNotificationStates(env.DB);

  for (const wf of workflows) {
    const key = `gh:${wf.owner}/${wf.repo}/${wf.workflow}`;
    const settings = allSettings[key] ?? { enabled: 0, failure_threshold: 1, notify_recovery: 0, urgency: null };
    if (!settings.enabled) continue; // skip API call entirely for disabled workflows

    const state = allStates[key] ?? { consecutive_down: 0, notified_down: 0 };
    const runStatus = await fetchGitHubWorkflowStatus(wf.owner, wf.repo, wf.workflow, env.GITHUB_TOKEN);
    if (!runStatus) continue;

    // Skip if we already processed this exact run
    const lastRunId = state.consecutive_down; // repurposed to store last-seen run ID
    if (runStatus.id === lastRunId) continue;

    const isFailed = runStatus.conclusion === 'failure';
    const displayName = wf.displayName ?? wf.workflow.replace(/\.(yml|yaml)$/, '');
    const repoName = wf.repo;

    if (isFailed) {
      if (!state.notified_down) {
        const title = `❌ Build Failed: ${repoName}`;
        const body = `${displayName} workflow failed`;
        const options = resolveNotificationOptions('build-failed', settings.urgency);
        console.log(`Sending build failure notification (urgency=${options.urgency}): ${repoName} / ${displayName}`);
        const result = await sendNotifications(
          env.DB,
          vapid,
          {
            title,
            body,
            tag: `build-fail-${key}`,
            url: `https://github.com/${wf.owner}/${wf.repo}/actions/workflows/${wf.workflow}`,
          },
          options,
        );
        await addNotificationLogEntry(env.DB, {
          key,
          type: 'build-failed',
          title,
          body,
          urgency: options.urgency,
          subscribersNotified: result.subscriberCount,
          delivered: result.delivered,
        });
        await updateNotificationState(env.DB, key, runStatus.id, result.delivered ? 1 : 0);
      } else {
        await updateNotificationState(env.DB, key, runStatus.id, 1);
      }
    } else {
      if (state.notified_down && settings.notify_recovery) {
        const title = `✅ Build Recovered: ${repoName}`;
        const body = `${displayName} workflow is passing again`;
        const options = resolveNotificationOptions('build-recovery', settings.urgency);
        console.log(`Sending build recovery notification (urgency=${options.urgency}): ${repoName} / ${displayName}`);
        const result = await sendNotifications(
          env.DB,
          vapid,
          {
            title,
            body,
            tag: `build-recovery-${key}`,
            url: `https://github.com/${wf.owner}/${wf.repo}/actions/workflows/${wf.workflow}`,
          },
          options,
        );
        await addNotificationLogEntry(env.DB, {
          key,
          type: 'build-recovery',
          title,
          body,
          urgency: options.urgency,
          subscribersNotified: result.subscriberCount,
          delivered: result.delivered,
        });
      }
      await updateNotificationState(env.DB, key, runStatus.id, 0);
    }
  }
}

/** Gather current-state observations for every timeline lane (services, GitHub
 *  workflows, DDNS clients) and fold them into the sparse transitions KV blob.
 *  Only flips are persisted (see updateTransitions). GitHub polling reuses the
 *  5-min in-memory cache, so re-reading every tick costs at most one API call
 *  per workflow per 5 minutes. Independent of notification settings — the
 *  timeline tracks all configured entities. */
async function recordTransitions(
  config: DashboardConfig,
  ddnsClients: DdnsClient[],
  env: Env,
  plan: PlanProfile,
  panels: PanelStatus[],
  now: number,
): Promise<void> {
  const observations: LaneObservation[] = [];

  // Services — skip internal-only services (the edge can't reach them).
  for (const panel of panels) {
    for (const svc of panel.services) {
      if (svc.internal) continue;
      const up: 0 | 1 =
        svc.knownStatus === 'known-down' ? 0 : svc.knownStatus === 'known-up' ? 1 : svc.status === 'up' ? 1 : 0;
      observations.push({
        key: svc.host ?? svc.name,
        kind: 'service',
        label: svc.name,
        up,
        ts: now,
        link: svc.host ? `https://${svc.host}` : undefined,
        detail: svc.reason,
      });
    }
  }

  // GitHub workflows — all configured workflows, conclusion 'success' = up.
  const workflows = config.githubWorkflows ?? [];
  const ghObs = await Promise.all(
    workflows.map(async (wf): Promise<LaneObservation | null> => {
      const runStatus = await fetchGitHubWorkflowStatus(wf.owner, wf.repo, wf.workflow, env.GITHUB_TOKEN);
      if (!runStatus) return null; // no data yet — don't fabricate a state
      const displayName = wf.displayName ?? wf.workflow.replace(/\.(yml|yaml)$/, '');
      return {
        key: `gh:${wf.owner}/${wf.repo}/${wf.workflow}`,
        kind: 'github',
        label: `${wf.repo} / ${displayName}`,
        up: runStatus.conclusion === 'success' ? 1 : 0,
        ts: now,
        link: `https://github.com/${wf.owner}/${wf.repo}/actions/workflows/${wf.workflow}`,
        detail: runStatus.conclusion ?? undefined,
      };
    }),
  );
  for (const o of ghObs) if (o) observations.push(o);

  // DDNS clients — alive if the last successful check-in is within the stale window.
  for (const client of ddnsClients) {
    const lastSuccess = await getLatestDdnsSuccess(env.DB, client.hostname);
    const up: 0 | 1 = lastSuccess !== null && now - lastSuccess <= DDNS_STALE_MS ? 1 : 0;
    observations.push({
      key: `ddns:${client.hostname}`,
      kind: 'ddns',
      label: client.label,
      up,
      ts: now,
      detail: lastSuccess ? undefined : 'never checked in',
    });
  }

  await updateTransitions(plan, env.KV, env.DB, observations);
}

/** Merge fresh check results with cached status, using config as source of truth for structure.
 * Fresh results override cached; unchecked services retain their previous state. */
function buildMergedStatus(
  config: DashboardConfig,
  freshResults: Map<string, { checks: CheckResult[]; wwwCheck?: CheckResult }>,
  cached: { panels: PanelStatus[]; lastUpdate: number } | null,
): PanelStatus[] {
  const cachedByHost = new Map<string, ServiceStatus>();
  for (const panel of cached?.panels ?? []) {
    for (const service of panel.services) {
      if (service.host) cachedByHost.set(service.host, service);
    }
  }

  return config.panels.map(configPanel => ({
    panel: configPanel.panel,
    services: configPanel.services.map(svc => {
      const primaryHost = Array.isArray(svc.host) ? svc.host[0] : svc.host;
      const fresh = freshResults.get(primaryHost);
      const cachedSvc = cachedByHost.get(primaryHost);
      const checks = fresh?.checks ?? cachedSvc?.checks ?? [];
      const wwwCheck = fresh ? fresh.wwwCheck : cachedSvc?.wwwCheck;
      const status = checks.length === 0 || checks.every(c => c.status === 'up') ? ('up' as const) : ('down' as const);

      return {
        name: svc.name ?? primaryHost,
        host: primaryHost,
        status,
        knownStatus: svc.status,
        reason: svc.reason,
        internal: svc.internal ?? false,
        checks,
        wwwCheck,
        location: svc.location,
        locationTitle: svc.locationTitle,
        provider: svc.provider,
        link: svc.link,
        labels: svc.labels,
      };
    }),
  }));
}

/** Merge config metadata with cached check results (config = source of truth for metadata) */
function mergeConfigWithStatus(
  config: DashboardConfig,
  cached: { panels: PanelStatus[]; lastUpdate: number } | null,
): {
  panels: PanelStatus[];
  lastUpdate: number | null;
} {
  // Index cached check data by host for fast lookup
  const cachedByHost = new Map<string, ServiceStatus>();
  for (const panel of cached?.panels ?? []) {
    for (const service of panel.services) {
      if (service.host) cachedByHost.set(service.host, service);
    }
  }

  // Build panels from config, merging in cached check results
  const panels: PanelStatus[] = config.panels.map(configPanel => ({
    panel: configPanel.panel,
    services: configPanel.services.map(svc => {
      const primaryHost = Array.isArray(svc.host) ? svc.host[0] : svc.host;
      const cached = cachedByHost.get(primaryHost);
      return {
        name: svc.name ?? primaryHost,
        host: primaryHost,
        status: cached?.status ?? ('down' as const),
        knownStatus: svc.status,
        reason: svc.reason,
        internal: svc.internal ?? false,
        checks: cached?.checks ?? [],
        wwwCheck: cached?.wwwCheck,
        location: svc.location,
        locationTitle: svc.locationTitle,
        provider: svc.provider,
        link: svc.link,
        labels: svc.labels,
      };
    }),
  }));

  return { panels, lastUpdate: cached?.lastUpdate ?? null };
}

/** Render the main dashboard page.
 *  Uses streaming: HTML with status + uptime renders immediately,
 *  chart data is appended at the end when the slower query finishes. */
/** Timeline lanes a viewer may see. DDNS lanes are keyed by hostname and
 *  reveal home networks, so they're admin-only like the DDNS log itself. */
function visibleTransitions(transitions: TransitionsState, admin: boolean): TransitionsState {
  if (admin) return transitions;
  return Object.fromEntries(Object.entries(transitions).filter(([key]) => !key.startsWith('ddns:')));
}

async function handleDashboard(
  config: DashboardConfig,
  env: Env,
  plan: PlanProfile,
  access: DashboardAccess,
): Promise<Response> {
  const { admin } = access;
  // Start all queries in parallel — chart query is slow, don't block HTML on it
  const chartsPromise = getChartData(plan, env.KV, env.DB);
  const transitionsPromise = getTransitions(plan, env.KV, env.DB).then(t => visibleTransitions(t, admin));
  // DDNS (home IPs) and cost data are admin-only, so don't even query them otherwise.
  const [cached, ddnsLog, uptime, costData] = await Promise.all([
    getCurrentStatus(plan, env.KV, env.DB),
    admin ? getRecentDdnsLog(plan, env.KV, env.DB, undefined, 50) : [],
    getMultiPeriodUptime(plan, env.KV, env.DB),
    admin ? fetchCostPanelData(env) : undefined,
  ]);
  const merged = mergeConfigWithStatus(config, cached);

  // Notification settings are still deployment-wide, so only an admin may
  // change them. Hide the bells from everyone else.
  const vapidKey = admin ? env.VAPID_PUBLIC_KEY : undefined;
  const html = renderDashboard(plan, config, merged, ddnsLog, vapidKey, uptime, undefined, costData, access);

  // Stream: send HTML immediately, then append chart data when ready
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      // Split HTML before </body> — inject chart data script there
      const splitIdx = html.lastIndexOf('</body>');
      await writer.write(encoder.encode(html.substring(0, splitIdx)));

      // Wait for chart data and inject as a deferred script
      const charts = await chartsPromise;
      if (charts && Object.keys(charts).length > 0) {
        const chartJson = JSON.stringify(charts);
        await writer.write(encoder.encode(`<script>window.__onChartsReady(${chartJson})</script>\n`));
      }

      // Inject the transition timeline data the same way.
      const transitions = await transitionsPromise;
      if (transitions && Object.keys(transitions).length > 0) {
        const tJson = JSON.stringify(transitions);
        await writer.write(encoder.encode(`<script>window.__onTransitionsReady(${tJson})</script>\n`));
      }

      await writer.write(encoder.encode(html.substring(splitIdx)));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

/** API: Combined poll endpoint (status + uptime + charts + ddns log in one call)
 *  Supports ?full=true for complete data (uptime + charts), otherwise lightweight (status + ddns only).
 *  Since initial page load inlines chart/uptime data, 30s polls only need status + ddns. */
async function handleApiPoll(
  config: DashboardConfig,
  request: Request,
  env: Env,
  plan: PlanProfile,
  admin: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  const full = url.searchParams.has('full');

  if (full) {
    const [cached, uptime, charts, ddnsLog, transitions] = await Promise.all([
      getCurrentStatus(plan, env.KV, env.DB),
      getMultiPeriodUptime(plan, env.KV, env.DB),
      getChartData(plan, env.KV, env.DB),
      admin ? getRecentDdnsLog(plan, env.KV, env.DB, undefined, 50) : [],
      getTransitions(plan, env.KV, env.DB),
    ]);
    const status = mergeConfigWithStatus(config, cached);
    return jsonResponse({ ...status, uptime, charts, ddnsLog, transitions: visibleTransitions(transitions, admin) });
  }

  // Lightweight poll: status + ddns only
  const [cached, ddnsLog] = await Promise.all([
    getCurrentStatus(plan, env.KV, env.DB),
    admin ? getRecentDdnsLog(plan, env.KV, env.DB, undefined, 50) : [],
  ]);
  const status = mergeConfigWithStatus(config, cached);
  return jsonResponse({ ...status, ddnsLog });
}

/** API: Get history for a specific check */
async function handleApiHistory(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const service = url.searchParams.get('service');
  const checkUrl = url.searchParams.get('url');

  if (!service || !checkUrl) {
    return jsonResponse({ error: 'Missing service or url parameter' }, 400);
  }

  const history = await getCheckHistory(env.DB, service, checkUrl);
  return jsonResponse({ service, url: checkUrl, history });
}

/** API: Receive probe results from browser */
async function handleApiProbe(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const results: CheckResult[] = await request.json();

  // Validate results have required fields
  for (const result of results) {
    if (!result.service || !result.url || !result.status) {
      return jsonResponse({ error: 'Invalid result format' }, 400);
    }
    // Ensure source is marked as browser
    result.source = 'browser';
  }

  // Add to history in background
  ctx.waitUntil(addToHistory(env.DB, results));

  return jsonResponse({ received: results.length });
}

/** API: Get recent check errors */
async function handleApiErrors(url: URL, env: Env): Promise<Response> {
  const service = url.searchParams.get('service') ?? undefined;
  const errors = await getRecentErrors(env.DB, service, 100, resolvePlan(env).historyRetentionDays);
  return jsonResponse({ errors });
}

/** API: Get recent DDNS log entries */
async function handleApiDdnsLog(url: URL, env: Env, plan: PlanProfile): Promise<Response> {
  const event = url.searchParams.get('event') ?? undefined;
  const entries = await getRecentDdnsLog(plan, undefined, env.DB, event);
  return jsonResponse({ entries });
}

/** Render the DDNS log page */
async function handleDdnsPage(url: URL, env: Env, plan: PlanProfile): Promise<Response> {
  const event = url.searchParams.get('event') ?? undefined;
  const entries = await getRecentDdnsLog(plan, undefined, env.DB, event);

  const rows = entries
    .map(e => {
      const time = new Date(e.timestamp);
      const ago = formatRelativeTime(e.timestamp);
      const pillClass = `pill pill-${e.event.replace('_', '-')}`;

      let changeHtml = '';
      if (e.event === 'ip_change') {
        changeHtml = `<span class="ip old">${escapeHtml(e.old_ip ?? '')}</span> <span class="arrow">&rarr;</span> <span class="ip new">${escapeHtml(e.new_ip ?? '')}</span>`;
      } else if (e.event === 'no_change') {
        changeHtml = `<span class="ip current">${escapeHtml(e.new_ip ?? '')}</span>`;
      } else {
        changeHtml = '-';
      }

      return `<tr>
        <td class="col-time" title="${escapeHtml(time.toLocaleString())}">${escapeHtml(ago)}</td>
        <td class="col-event"><a href="/ddns?event=${encodeURIComponent(e.event)}"><span class="${pillClass}">${escapeHtml(e.event.replace('_', ' ').toUpperCase())}</span></a></td>
        <td class="col-host">${escapeHtml(e.hostname ?? '-')}</td>
        <td class="col-zone">${escapeHtml(e.zone ?? '-')}</td>
        <td class="col-ip">${changeHtml}</td>
        <td class="col-source-ip">${escapeHtml(e.source_ip ?? '-')}</td>
        <td class="col-status">${e.status_code}</td>
        <td class="col-message">${escapeHtml(e.message)}</td>
      </tr>`;
    })
    .join('');

  const titleText = event ? `DDNS Log: ${escapeHtml(event.replace('_', ' '))}` : 'DDNS Log';
  const filterInfo = event ? `<a href="/ddns" class="clear-filter">All events</a>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#161b22">
  <title>${titleText} - Uptime Monitor</title>
  <script>
    (function() {
      const stored = localStorage.getItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = stored || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f6f8fa' : '#161b22';
    })();
  </script>
  <style>
    :root {
      --bg-body: #0d1117; --bg-panel: #161b22; --bg-row-hover: #1c2128;
      --border: #30363d; --text: #c9d1d9; --text-muted: #8b949e; --text-link: #58a6ff;
      --color-up: #3fb950; --color-down: #f85149; --color-warn: #d29922;
    }
    [data-theme="light"] {
      --bg-body: #f6f8fa; --bg-panel: #ffffff; --bg-row-hover: #f6f8fa;
      --border: #d0d7de; --text: #1f2328; --text-muted: #656d76; --text-link: #0969da;
      --color-up: #1a7f37; --color-down: #cf222e; --color-warn: #9a6700;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; background: var(--bg-body); color: var(--text); padding: 1.5rem; transition: background-color 0.2s, color 0.2s; }
    .header { max-width: 1400px; margin: 0 auto 1.5rem; display: flex; justify-content: space-between; align-items: center; }
    .header-left { display: flex; align-items: center; gap: 0.75rem; }
    .header h1 { font-size: 1rem; font-weight: 400; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .header a { color: var(--text-link); text-decoration: none; font-size: 0.813rem; }
    .header a:hover { text-decoration: underline; }
    .clear-filter { font-size: 0.75rem; }
    .panel { max-width: 1400px; margin: 0 auto; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; transition: background-color 0.2s, border-color 0.2s; }
    .count { font-size: 0.75rem; color: var(--text-muted); padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; font-size: 0.813rem; }
    th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); color: var(--text-muted); font-weight: 500; font-size: 0.688rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg-row-hover); }
    .col-time { white-space: nowrap; color: var(--text-muted); min-width: 5rem; }
    .col-event a { text-decoration: none; }
    .col-host { font-weight: 500; color: var(--text-link); white-space: nowrap; }
    .col-zone { color: var(--text-muted); white-space: nowrap; }
    .col-ip { white-space: nowrap; font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace; font-size: 0.75rem; }
    .ip.old { color: var(--text-muted); text-decoration: line-through; opacity: 0.7; }
    .arrow { color: var(--text-muted); margin: 0 0.25rem; }
    .ip.new { color: var(--color-up); font-weight: 500; }
    .ip.current { color: var(--text); }
    .col-source-ip { color: var(--text-muted); font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace; font-size: 0.75rem; }
    .col-status { text-align: center; font-variant-numeric: tabular-nums; }
    .col-message { color: var(--text-muted); max-width: 300px; }
    .pill { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 1rem; font-size: 0.688rem; font-weight: 500; white-space: nowrap; }
    .pill-ip-change { background: rgba(63, 185, 80, 0.15); color: var(--color-up); border: 1px solid rgba(63, 185, 80, 0.3); }
    .pill-no-change { background: rgba(139, 148, 158, 0.1); color: var(--text-muted); border: 1px solid rgba(139, 148, 158, 0.2); }
    .pill-rejected { background: rgba(248, 81, 73, 0.15); color: var(--color-down); border: 1px solid rgba(248, 81, 73, 0.3); }
    .pill-not-found { background: rgba(210, 153, 34, 0.15); color: var(--color-warn); border: 1px solid rgba(210, 153, 34, 0.3); }
    .pill-error { background: rgba(248, 81, 73, 0.15); color: var(--color-down); border: 1px solid rgba(248, 81, 73, 0.3); }
    .empty { padding: 2rem; text-align: center; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>${titleText}</h1>
      ${filterInfo}
    </div>
    <a href="/">&larr; Dashboard</a>
  </div>
  <div class="panel">
    <div class="count">${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'}</div>
    ${
      entries.length === 0
        ? '<div class="empty">No recent DDNS log entries</div>'
        : `<table>
      <thead><tr>
        <th>When</th><th>Event</th><th>Hostname</th><th>Zone</th><th>IP</th><th>Source</th><th>Status</th><th>Message</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    }
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

/** API: List or delete push subscriptions */
async function handleApiSubscriptions(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    const subs = await getAllPushSubscriptions(env.DB);
    return jsonResponse({ subscriptions: subs });
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const idStr = url.searchParams.get('id');
    if (!idStr) return jsonResponse({ error: 'Missing ?id parameter' }, 400);
    const id = parseInt(idStr, 10);
    if (isNaN(id)) return jsonResponse({ error: 'Invalid id' }, 400);
    const deleted = await removePushSubscriptionById(env.DB, id);
    if (!deleted) return jsonResponse({ error: 'Subscription not found' }, 404);
    return jsonResponse({ ok: true, deleted: id });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

/** Render the push subscriptions management page */
async function handleSubscriptionsPage(env: Env): Promise<Response> {
  const subs = await getAllPushSubscriptions(env.DB);

  const rows = subs
    .map(s => {
      let label = s.endpoint;
      try {
        const u = new URL(s.endpoint);
        label = u.hostname + u.pathname.slice(0, 24) + (u.pathname.length > 24 ? '…' : '');
      } catch {
        /* use raw endpoint */
      }

      const created = formatRelativeTime(s.created_at);
      const createdFull = new Date(s.created_at).toLocaleString();
      const lastNotif = s.last_notified ? formatRelativeTime(s.last_notified) : 'never';
      const lastNotifFull = s.last_notified ? new Date(s.last_notified).toLocaleString() : '';

      return `<tr data-id="${s.id}">
        <td class="col-id">${s.id}</td>
        <td class="col-endpoint" title="${escapeHtml(s.endpoint)}">${escapeHtml(label)}</td>
        <td class="col-time" title="${escapeHtml(createdFull)}">${escapeHtml(created)}</td>
        <td class="col-time" title="${escapeHtml(lastNotifFull)}">${escapeHtml(lastNotif)}</td>
        <td class="col-action"><button class="btn-delete" onclick="deleteSub(${s.id}, this)">Delete</button></td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#161b22">
  <title>Push Subscriptions - Uptime Monitor</title>
  <script>
    (function() {
      const stored = localStorage.getItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = stored || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f6f8fa' : '#161b22';
    })();
  </script>
  <style>
    :root {
      --bg-body: #0d1117; --bg-panel: #161b22; --bg-row-hover: #1c2128;
      --border: #30363d; --text: #c9d1d9; --text-muted: #8b949e; --text-link: #58a6ff;
      --color-down: #f85149;
    }
    [data-theme="light"] {
      --bg-body: #f6f8fa; --bg-panel: #ffffff; --bg-row-hover: #f6f8fa;
      --border: #d0d7de; --text: #1f2328; --text-muted: #656d76; --text-link: #0969da;
      --color-down: #cf222e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; background: var(--bg-body); color: var(--text); padding: 1.5rem; transition: background-color 0.2s, color 0.2s; }
    .header { max-width: 1400px; margin: 0 auto 1.5rem; display: flex; justify-content: space-between; align-items: center; }
    .header-left { display: flex; align-items: center; gap: 0.75rem; }
    .header h1 { font-size: 1rem; font-weight: 400; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .header a { color: var(--text-link); text-decoration: none; font-size: 0.813rem; }
    .header a:hover { text-decoration: underline; }
    .panel { max-width: 1400px; margin: 0 auto; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; transition: background-color 0.2s, border-color 0.2s; }
    .count { font-size: 0.75rem; color: var(--text-muted); padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; font-size: 0.813rem; }
    th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); color: var(--text-muted); font-weight: 500; font-size: 0.688rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg-row-hover); }
    .col-id { color: var(--text-muted); text-align: center; width: 3rem; }
    .col-endpoint { word-break: break-all; max-width: 400px; }
    .col-time { white-space: nowrap; color: var(--text-muted); }
    .col-action { text-align: center; width: 5rem; }
    .btn-delete { background: none; border: 1px solid var(--color-down); color: var(--color-down); padding: 0.2rem 0.5rem; border-radius: 0.25rem; cursor: pointer; font-size: 0.75rem; font-family: inherit; }
    .btn-delete:hover { background: var(--color-down); color: #fff; }
    .btn-delete:disabled { opacity: 0.4; cursor: not-allowed; }
    .empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    tr.deleting td { opacity: 0.4; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Push Subscriptions</h1>
    </div>
    <a href="/">&larr; Dashboard</a>
  </div>
  <div class="panel">
    <div class="count" id="count">${subs.length} subscription${subs.length !== 1 ? 's' : ''}</div>
    ${
      subs.length === 0
        ? '<div class="empty">No push subscriptions registered</div>'
        : `<table>
      <thead><tr>
        <th>ID</th><th>Endpoint</th><th>Created</th><th>Last Notified</th><th></th>
      </tr></thead>
      <tbody id="subs-body">${rows}</tbody>
    </table>`
    }
  </div>
  <script>
    async function deleteSub(id, btn) {
      if (!confirm('Delete subscription #' + id + '?')) return;
      btn.disabled = true;
      const row = btn.closest('tr');
      row.classList.add('deleting');
      try {
        const res = await fetch('/api/subscriptions?id=' + id, { method: 'DELETE' });
        if (res.ok) {
          row.remove();
          const remaining = document.querySelectorAll('#subs-body tr').length;
          document.getElementById('count').textContent = remaining + ' subscription' + (remaining !== 1 ? 's' : '');
          if (remaining === 0) {
            document.querySelector('.panel table')?.remove();
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No push subscriptions registered';
            document.querySelector('.panel').appendChild(empty);
          }
        } else {
          const data = await res.json();
          alert('Failed: ' + (data.error || res.status));
          row.classList.remove('deleting');
          btn.disabled = false;
        }
      } catch (err) {
        alert('Error: ' + err.message);
        row.classList.remove('deleting');
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

/** Render the errors page */
async function handleErrorsPage(url: URL, env: Env): Promise<Response> {
  const service = url.searchParams.get('service') ?? undefined;
  const errors = await getRecentErrors(env.DB, service, 100, resolvePlan(env).historyRetentionDays);

  const rows = errors
    .map(e => {
      const time = new Date(e.timestamp);
      const ago = formatRelativeTime(e.timestamp);
      const code = e.code ?? '-';
      const error = escapeHtml(e.error ?? '');
      return `<tr>
        <td class="col-time" title="${escapeHtml(time.toLocaleString())}">${escapeHtml(ago)}</td>
        <td class="col-service"><a href="/errors?service=${encodeURIComponent(e.service)}">${escapeHtml(e.service)}</a></td>
        <td class="col-url"><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.url)}</a></td>
        <td class="col-code">${code}</td>
        <td class="col-error">${error}</td>
        <td class="col-latency">${e.error === 'Timeout' ? 'timeout' : e.latency + 'ms'}</td>
        <td class="col-source">${escapeHtml(e.source)}</td>
      </tr>`;
    })
    .join('');

  const titleText = service ? `Errors: ${escapeHtml(service)}` : 'Recent Errors';
  const filterInfo = service ? `<a href="/errors" class="clear-filter">All services</a>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#161b22">
  <title>${titleText} - Uptime Monitor</title>
  <script>
    (function() {
      const stored = localStorage.getItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = stored || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f6f8fa' : '#161b22';
    })();
  </script>
  <style>
    :root {
      --bg-body: #0d1117; --bg-panel: #161b22; --bg-row-hover: #1c2128;
      --border: #30363d; --text: #c9d1d9; --text-muted: #8b949e; --text-link: #58a6ff;
      --color-down: #f85149; --color-warn: #d29922;
    }
    [data-theme="light"] {
      --bg-body: #f6f8fa; --bg-panel: #ffffff; --bg-row-hover: #f6f8fa;
      --border: #d0d7de; --text: #1f2328; --text-muted: #656d76; --text-link: #0969da;
      --color-down: #cf222e; --color-warn: #9a6700;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; background: var(--bg-body); color: var(--text); padding: 1.5rem; transition: background-color 0.2s, color 0.2s; }
    .header { max-width: 1400px; margin: 0 auto 1.5rem; display: flex; justify-content: space-between; align-items: center; }
    .header-left { display: flex; align-items: center; gap: 0.75rem; }
    .header h1 { font-size: 1rem; font-weight: 400; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .header a { color: var(--text-link); text-decoration: none; font-size: 0.813rem; }
    .header a:hover { text-decoration: underline; }
    .clear-filter { font-size: 0.75rem; }
    .panel { max-width: 1400px; margin: 0 auto; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; transition: background-color 0.2s, border-color 0.2s; }
    .count { font-size: 0.75rem; color: var(--text-muted); padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; font-size: 0.813rem; }
    th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); color: var(--text-muted); font-weight: 500; font-size: 0.688rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg-row-hover); }
    .col-time { white-space: nowrap; color: var(--text-muted); min-width: 5rem; }
    .col-service { white-space: nowrap; font-weight: 500; }
    .col-service a { color: var(--text-link); text-decoration: none; }
    .col-service a:hover { text-decoration: underline; }
    .col-url a { color: var(--text-link); text-decoration: none; word-break: break-all; }
    .col-url a:hover { text-decoration: underline; }
    .col-code { text-align: center; font-variant-numeric: tabular-nums; }
    .col-error { color: var(--color-down); max-width: 300px; }
    .col-latency { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .col-source { color: var(--text-muted); }
    .empty { padding: 2rem; text-align: center; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>${titleText}</h1>
      ${filterInfo}
    </div>
    <a href="/">&larr; Dashboard</a>
  </div>
  <div class="panel">
    <div class="count">${errors.length} error${errors.length !== 1 ? 's' : ''}</div>
    ${
      errors.length === 0
        ? '<div class="empty">No recent errors</div>'
        : `<table>
      <thead><tr>
        <th>When</th><th>Service</th><th>URL</th><th>Code</th><th>Error</th><th>Latency</th><th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    }
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

/** Format relative time for errors page */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** API: Delete all history for a service */
async function handleDeleteHistory(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const service = url.searchParams.get('service');

  if (!service) {
    return jsonResponse({ error: 'Missing service parameter' }, 400);
  }

  const deleted = await deleteServiceHistory(env.DB, service);
  return jsonResponse({ service, deleted });
}

/** API: Register a push subscription */
async function handleApiSubscribe(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!getVapid(env)) {
    return jsonResponse({ error: 'Push notifications not configured (VAPID incomplete)' }, 503);
  }

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return jsonResponse({ error: 'Missing required fields: endpoint, keys.p256dh, keys.auth' }, 400);
  }

  // Validate endpoint is an HTTPS URL to prevent SSRF
  try {
    const endpointUrl = new URL(body.endpoint);
    if (endpointUrl.protocol !== 'https:') {
      return jsonResponse({ error: 'Endpoint must be an HTTPS URL' }, 400);
    }
  } catch {
    return jsonResponse({ error: 'Invalid endpoint URL' }, 400);
  }

  if (body.endpoint.length > 2048) {
    return jsonResponse({ error: 'Endpoint URL too long' }, 400);
  }

  await addPushSubscription(env.DB, body.endpoint, body.keys.p256dh, body.keys.auth);
  return jsonResponse({ ok: true });
}

/** API: Remove a push subscription */
async function handleApiUnsubscribe(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  let body: { endpoint?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  if (!body.endpoint) {
    return jsonResponse({ error: 'Missing endpoint' }, 400);
  }

  await removePushSubscription(env.DB, body.endpoint);
  return jsonResponse({ ok: true });
}

/** API: Get or update notification settings for a key.
 *  GET without ?key returns all settings (bulk); with ?key returns one. */
async function handleApiNotificationSettings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const key = url.searchParams.get('key');
    if (key) {
      const settings = await getNotificationSettings(env.DB, key);
      return jsonResponse({ key, ...settings });
    }
    // Bulk: return all notification settings in one response
    const all = await getAllNotificationSettings(env.DB);
    return jsonResponse(all);
  }

  if (request.method === 'POST') {
    let body: {
      key?: string;
      enabled?: number;
      failure_threshold?: number;
      notify_recovery?: number;
      urgency?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    if (!body.key) return jsonResponse({ error: 'Missing key' }, 400);

    const enabled =
      typeof body.enabled === 'number' && Number.isFinite(body.enabled) ? (body.enabled === 0 ? 0 : 1) : 0;
    const failure_threshold = typeof body.failure_threshold === 'number' ? Math.max(1, body.failure_threshold) : 1;
    const notify_recovery =
      typeof body.notify_recovery === 'number' && Number.isFinite(body.notify_recovery)
        ? body.notify_recovery === 0
          ? 0
          : 1
        : 0;
    const validUrgencies = ['very-low', 'low', 'normal', 'high'];
    const urgency =
      typeof body.urgency === 'string' && validUrgencies.includes(body.urgency) ? (body.urgency as PushUrgency) : null;

    await setNotificationSettings(env.DB, body.key, { enabled, failure_threshold, notify_recovery, urgency });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

/** Helper: Create JSON response */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
  });
}

// ============================================
// Cost monitor
// ============================================

/** POST /api/usage — apps fire-and-forget usage reports (tokens, etc.). */
async function handleApiUsage(request: Request, env: Env): Promise<Response> {
  const override = await getPricingOverride(env.KV);
  const pricing = mergePricing(override);
  return handleUsagePost(request, env.DB, pricing);
}

/** Fetch all data the dashboard cost panel needs in parallel. Never throws —
 *  a cost-tracking storage failure must not break the dashboard render. */
async function fetchCostPanelData(env: Env): Promise<CostPanelData | undefined> {
  if (!env.DB || !env.KV) return undefined;
  try {
    const now = Date.now();
    const nowHour = hourBucket(now);
    const since24h = nowHour - 23;
    const monthStart = monthStartHourBucket(now);
    const prevMonthStart = prevMonthStartHourBucket(now);
    const [providers, hourly, thresholds, thisBillingPeriod, lastMonth] = await Promise.all([
      getCostByProvider(env.DB, since24h),
      getHourlySamples(env.DB, since24h),
      getThresholdStatus(env.KV, env.DB),
      getCostByProvider(env.DB, monthStart),
      getCostByProvider(env.DB, prevMonthStart, monthStart),
    ]);
    const total24hMicros = providers.reduce((sum, p) => sum + p.costMicros, 0n);
    const totalBillingPeriodMicros = thisBillingPeriod.reduce((sum, p) => sum + p.costMicros, 0n);
    const totalLastMonthMicros = lastMonth.reduce((sum, p) => sum + p.costMicros, 0n);
    return {
      providers,
      hourly,
      thresholds,
      total24hMicros,
      thisBillingPeriod,
      totalBillingPeriodMicros,
      lastMonth,
      totalLastMonthMicros,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Cost panel data fetch failed:', error.message);
    return undefined;
  }
}

/** GET /api/cost — rolled-up cost data for the dashboard panel. Returns USD. */
async function handleApiCost(env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ providers: [], hourly: [], this_billing_period: [], last_month: [] });
  const now = Date.now();
  const nowHour = hourBucket(now);
  const since24h = nowHour - 23;
  const monthStart = monthStartHourBucket(now);
  const prevMonthStart = prevMonthStartHourBucket(now);
  const [byProvider, hourly, thisBillingPeriod, lastMonth] = await Promise.all([
    getCostByProvider(env.DB, since24h),
    getHourlySamples(env.DB, since24h),
    getCostByProvider(env.DB, monthStart),
    getCostByProvider(env.DB, prevMonthStart, monthStart),
  ]);
  const toUsdRow = (p: { provider: string; costMicros: bigint }) => ({
    provider: p.provider,
    cost_usd: Number(p.costMicros) / 1_000_000,
  });
  return jsonResponse({
    providers: byProvider.map(toUsdRow),
    hourly: hourly.map(h => ({
      hour_bucket: h.hourBucket,
      provider: h.provider,
      cost_usd: Number(h.costMicros) / 1_000_000,
    })),
    this_billing_period: thisBillingPeriod.map(toUsdRow),
    last_month: lastMonth.map(toUsdRow),
  });
}

/** Run the hourly CF Analytics poll. Wrapped so a failure can't bubble up
 *  and take down uptime monitoring. */
async function pollCloudflareUsageSafely(env: Env): Promise<void> {
  if (!env.DB || !env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    console.log('Cost monitor: skipping CF poll (missing DB, CF_ANALYTICS_TOKEN, or CF_ACCOUNT_ID)');
    return;
  }
  try {
    const override = await getPricingOverride(env.KV);
    const pricing = mergePricing(override);
    const result = await pollCloudflareUsage(env.DB, env.CF_ANALYTICS_TOKEN, env.CF_ACCOUNT_ID, pricing);
    console.log(`Cost monitor: CF poll recorded ${result.rowsRecorded} rows for hourBucket=${result.hourBucketPolled}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Cost monitor: CF poll failed:', error.message);
  }
}

/** Check thresholds + dispatch any alerts. Wrapped so a failure can't bubble. */
async function checkAndFireThresholdAlerts(env: Env): Promise<void> {
  if (!env.DB || !env.KV) return;
  try {
    const alerts = await checkThresholds(env.KV, env.DB);
    if (alerts.length === 0) return;
    const vapid = getVapid(env);
    if (!vapid) {
      console.warn(`Cost monitor: ${alerts.length} threshold alert(s) but VAPID not configured`);
      return;
    }
    const fired: typeof alerts = [];
    for (const alert of alerts) {
      const { title, body } = alertNotificationContent(alert);
      const options: NotificationDisplayOptions = {
        urgency: alert.urgency ?? 'high',
        requireInteraction: true,
        silent: false,
      };
      try {
        const result = await sendNotifications(env.DB, vapid, { title, body, tag: alert.key, url: '/' }, options);
        await addNotificationLogEntry(env.DB, {
          key: alert.key,
          type: 'usage-threshold',
          title,
          body,
          urgency: options.urgency,
          subscribersNotified: result.subscriberCount,
          delivered: result.delivered,
        });
        fired.push(alert);
        console.log(`Cost monitor: fired alert ${alert.key} — ${body}`);
      } catch (err) {
        // Don't mark as fired so we retry next tick — but other alerts in this
        // batch can still proceed.
        console.error(`Cost monitor: failed to dispatch alert ${alert.key}:`, err);
      }
    }
    // Single KV write covering every successfully-sent alert in this tick.
    if (fired.length > 0) await markThresholdsFired(env.KV, fired);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Cost monitor: threshold check failed:', error.message);
  }
}
