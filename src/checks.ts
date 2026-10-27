import type {
  ServiceConfig,
  HttpCheckConfig,
  HttpCheckDetails,
  CheckResult,
  ServiceStatus,
  PanelStatus,
  DashboardConfig,
} from './types';
import { probeSecretOnce } from './socket-probe';

const DEFAULT_TIMEOUT = 10000; // 10 seconds

/** Normalize check config to full details object */
function normalizeHttpCheck(check: HttpCheckConfig): HttpCheckDetails {
  if (typeof check === 'string') {
    return { url: check };
  }
  return check;
}

/** Build full URL from host and path */
function buildUrl(protocol: 'http' | 'https', host: string, path: string): string {
  // If path is already a full URL, use it directly
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${protocol}://${host}${normalizedPath}`;
}

/** Single fetch attempt. Returns a CheckResult, or null if the worker has hit
 *  its subrequest budget (caller treats null as "stop scheduling more"). */
async function attemptCheckOnce(
  serviceName: string,
  url: string,
  protocol: 'http' | 'https',
  method: string,
  headers: Record<string, string> | undefined,
  body: string | undefined,
  timeoutMs: number,
  validate: (code: number, response: Response) => { status: 'up' } | { status: 'down'; error: string },
  source: 'edge' | 'browser',
): Promise<CheckResult | null> {
  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    });

    clearTimeout(timeoutId);

    const validation = validate(response.status, response);

    // We only need status + headers; cancel the body to free the connection
    await response.body?.cancel();

    return {
      service: serviceName,
      url,
      type: protocol,
      status: validation.status,
      code: response.status,
      latency: Date.now() - startTime,
      error: validation.status === 'down' ? validation.error : undefined,
      timestamp: Date.now(),
      source,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('Too many subrequests')) {
      return null;
    }
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    return {
      service: serviceName,
      url,
      type: protocol,
      status: 'down',
      latency: Date.now() - startTime,
      error: errMsg.includes('abort') ? 'Timeout' : errMsg,
      timestamp: Date.now(),
      source,
    };
  }
}

/** Run a check, retrying once on any failure if the previous recorded result
 *  for this URL was 'up'. The two round-trips collapse into one CheckResult
 *  whose latency spans the whole wall-clock — a one-off glitch (timeout,
 *  transient 5xx, dropped connection) surfaces as a tall latency bar instead
 *  of a misleading 'down' point. Skipping retry when the prior result was
 *  already 'down' prevents a genuine outage from being masked or doubling the
 *  work per tick. */
async function attemptWithRetry(
  attempt: () => Promise<CheckResult | null>,
  previousResult: CheckResult | undefined,
  startTime: number,
): Promise<CheckResult | null> {
  const result = await attempt();
  if (!result) return null;

  if (result.status !== 'down' || previousResult?.status !== 'up') return result;

  const retry = await attempt();
  if (!retry) return result;

  retry.latency = Date.now() - startTime;
  return retry;
}

/** Execute a single HTTP(S) check */
export async function runHttpCheck(
  serviceName: string,
  host: string,
  protocol: 'http' | 'https',
  checkConfig: HttpCheckConfig,
  serviceTimeout?: number,
  source: 'edge' | 'browser' = 'edge',
  previousResult?: CheckResult,
): Promise<CheckResult | null> {
  const check = normalizeHttpCheck(checkConfig);
  const url = buildUrl(protocol, host, check.url);
  const timeoutMs = (check.timeout ?? serviceTimeout ?? 10) * 1000;
  const method = check.method ?? 'GET';
  const expectedStatus = check.expect ?? 200;

  const validate = (code: number, response: Response): { status: 'up' } | { status: 'down'; error: string } => {
    if (check.redirect) {
      if (code >= 300 && code < 400) {
        const location = response.headers.get('location');
        if (location === check.redirect || location?.includes(check.redirect)) {
          return { status: 'up' };
        }
        return { status: 'down', error: `Expected redirect to ${check.redirect}, got ${location}` };
      }
      return { status: 'down', error: `Expected redirect (3xx), got ${code}` };
    }
    if (code === expectedStatus) return { status: 'up' };
    // Accept any 2xx when expecting 200
    if (expectedStatus === 200 && code >= 200 && code < 300) return { status: 'up' };
    return { status: 'down', error: `Expected ${expectedStatus}, got ${code}` };
  };

  const startTime = Date.now();
  return attemptWithRetry(
    () => attemptCheckOnce(serviceName, url, protocol, method, check.headers, check.body, timeoutMs, validate, source),
    previousResult,
    startTime,
  );
}

/** Run www redirect check.
 *  Default: expect http://www.host → https://host/.
 *  Override `expectedRedirect` when www points somewhere other than apex
 *  (e.g. an alias domain whose canonical URL is elsewhere).
 */
async function runWwwCheck(
  serviceName: string,
  host: string,
  timeout: number,
  source: 'edge' | 'browser',
  expectedRedirect: string = `https://${host}/`,
  previousResult?: CheckResult,
): Promise<CheckResult | null> {
  const wwwHost = `www.${host}`;
  const url = `http://${wwwHost}/`;
  const trimmed = expectedRedirect.replace(/\/$/, '');

  const validate = (code: number, response: Response): { status: 'up' } | { status: 'down'; error: string } => {
    if (code >= 300 && code < 400) {
      const location = response.headers.get('location');
      // Accept the expected target with or without trailing slash, plus any sub-path under it
      if (location && (location === expectedRedirect || location === trimmed || location.startsWith(`${trimmed}/`))) {
        return { status: 'up' };
      }
      return { status: 'down', error: `Redirects to ${location} instead of ${expectedRedirect}` };
    }
    return { status: 'down', error: `Expected redirect (3xx), got ${code}` };
  };

  const startTime = Date.now();
  return attemptWithRetry(
    () => attemptCheckOnce(serviceName, url, 'http', 'GET', undefined, undefined, timeout, validate, source),
    previousResult,
    startTime,
  );
}

/** Run all checks for a single service. `previousResults` (URL → prior
 *  CheckResult) is consulted by the retry-on-timeout logic in runHttpCheck /
 *  runWwwCheck; safe to omit for one-off / dev-mode runs. */
export async function runServiceChecks(
  service: ServiceConfig,
  source: 'edge' | 'browser' = 'edge',
  previousResults?: Map<string, CheckResult>,
): Promise<{ checks: CheckResult[]; wwwCheck?: CheckResult; budgetExhausted?: boolean }> {
  // Skip internal services when running from edge
  if (service.internal && source === 'edge') {
    return { checks: [] };
  }

  const hosts = Array.isArray(service.host) ? service.host : [service.host];
  const primaryHost = hosts[0];
  const timeout = (service.timeout ?? 10) * 1000;
  const checks: CheckResult[] = [];
  const lookup = (url: string) => previousResults?.get(url);

  // A secret service is one direct socket check; its host is `secret:<id>`.
  const { secret } = service;
  if (secret) {
    if (source !== 'edge') return { checks: [] };
    const result = await attemptWithRetry(
      () => probeSecretOnce(primaryHost, secret, source),
      lookup(`secret://${secret.id}`),
      Date.now(),
    );
    if (result === null) return { checks, budgetExhausted: true };
    return { checks: [result] };
  }

  for (const host of hosts) {
    // HTTP checks
    if (service.http) {
      const httpChecks = Array.isArray(service.http) ? service.http : [service.http];
      for (const check of httpChecks) {
        const url = buildUrl('http', host, normalizeHttpCheck(check).url);
        const result = await runHttpCheck(primaryHost, host, 'http', check, service.timeout, source, lookup(url));
        if (result === null) return { checks, budgetExhausted: true };
        checks.push(result);
      }
    }

    // HTTPS checks
    if (service.https) {
      const httpsChecks = Array.isArray(service.https) ? service.https : [service.https];
      for (const check of httpsChecks) {
        const url = buildUrl('https', host, normalizeHttpCheck(check).url);
        const result = await runHttpCheck(primaryHost, host, 'https', check, service.timeout, source, lookup(url));
        if (result === null) return { checks, budgetExhausted: true };
        checks.push(result);
      }
    }
  }

  // WWW redirect check (primary host only)
  let wwwCheck: CheckResult | undefined;
  if (service.www) {
    const expectedRedirect = typeof service.www === 'object' ? service.www.redirect : undefined;
    const wwwUrl = `http://www.${primaryHost}/`;
    const result = await runWwwCheck(primaryHost, primaryHost, timeout, source, expectedRedirect, lookup(wwwUrl));
    if (result === null) return { checks, budgetExhausted: true };
    wwwCheck = result;
  }

  return { checks, wwwCheck };
}

/** Build service status from check results */
export function buildServiceStatus(
  service: ServiceConfig,
  checks: CheckResult[],
  wwwCheck?: CheckResult,
): ServiceStatus {
  // Overall status is 'down' if any check is down (www check doesn't affect overall status)
  const status = checks.length === 0 || checks.every(c => c.status === 'up') ? 'up' : 'down';

  const primaryHost = Array.isArray(service.host) ? service.host[0] : service.host;

  return {
    name: service.name ?? primaryHost,
    host: primaryHost,
    status,
    knownStatus: service.status,
    reason: service.reason,
    internal: service.internal ?? false,
    checks,
    wwwCheck,
    location: service.location,
    locationTitle: service.locationTitle,
    provider: service.provider,
    link: service.link,
    labels: service.labels,
  };
}

/** Run all checks for the entire dashboard config */
export async function runAllChecks(
  config: DashboardConfig,
  source: 'edge' | 'browser' = 'edge',
): Promise<PanelStatus[]> {
  const panels: PanelStatus[] = [];

  for (const panel of config.panels) {
    const services: ServiceStatus[] = [];

    // Run checks for all services in parallel
    const serviceResults = await Promise.all(
      panel.services.map(async service => {
        const { checks, wwwCheck } = await runServiceChecks(service, source);
        return buildServiceStatus(service, checks, wwwCheck);
      }),
    );

    services.push(...serviceResults);

    panels.push({
      panel: panel.panel,
      services,
    });
  }

  return panels;
}

/** Concurrency pool config: "max periodMs start increment" (all optional).
 * e.g. "25 10 1 2" → ramp from 1 to 25 concurrent checks, adding 2 slots every 10ms. */
export interface ConcurrencyConfig {
  max: number; // max concurrent checks (default 25)
  periodMs: number; // ms between ramp increments (default 10)
  start: number; // initial concurrency (default 1)
  increment: number; // slots to add per period (default = start)
}

export function parseConcurrency(raw?: string): ConcurrencyConfig {
  const parts = (raw ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
  const max = parts[0] || 25;
  const periodMs = parts[1] || 10;
  const start = parts[2] || 1;
  const increment = parts[3] || start;
  return { max, periodMs, start, increment };
}

/** How many outbound fetches one service costs in a single sweep.
 *  Retries (runHttpCheck's retry-on-glitch) can add up to one more per URL —
 *  callers should keep headroom rather than have this over-report every tick. */
export function estimateSubrequests(service: ServiceConfig, source: 'edge' | 'browser' = 'edge'): number {
  if (service.internal && source === 'edge') return 0;
  if (service.secret) return source === 'edge' ? 1 : 0;
  const hosts = Array.isArray(service.host) ? service.host : [service.host];
  const httpCount = service.http ? (Array.isArray(service.http) ? service.http.length : 1) : 0;
  const httpsCount = service.https ? (Array.isArray(service.https) ? service.https.length : 1) : 0;
  return hosts.length * (httpCount + httpsCount) + (service.www ? 1 : 0);
}

/** Run checks with a concurrency-limited pool and priority + stochastic ordering.
 * Services with notifications enabled are checked first, then remaining services.
 * Within each group, least-recently-checked services go first (with jitter to prevent starvation).
 * Concurrency ramps up from `start` to `max` over time.
 *
 * Stops launching on either budget: `maxSubrequests` proactively (before the
 * runtime would throw), or a runtime "Too many subrequests" reactively. The
 * proactive cap is what makes the free plan viable — its ceiling is 50
 * subrequests per invocation, and hitting it mid-sweep would starve the
 * GitHub polling and push delivery that run afterward in `waitUntil`.
 *
 * Unchecked services aren't dropped from the dashboard: the caller merges fresh
 * results over the previous cached status, and the staleness-ordered sort means
 * the next tick picks up where this one left off. */
export async function runBudgetedChecks(
  config: DashboardConfig,
  lastCheckedTimes: Map<string, number>,
  source: 'edge' | 'browser' = 'edge',
  priorityKeys?: Set<string>,
  concurrency?: ConcurrencyConfig,
  previousResults?: Map<string, CheckResult>,
  maxSubrequests?: number,
): Promise<Map<string, { checks: CheckResult[]; wwwCheck?: CheckResult }>> {
  const cfg = concurrency ?? parseConcurrency();
  const results = new Map<string, { checks: CheckResult[]; wwwCheck?: CheckResult }>();
  let budgetDone = false;
  let currentLimit = cfg.start;
  const budget = maxSubrequests ?? Infinity;
  let spent = 0;

  // Flatten all eligible services
  const allServices = config.panels.flatMap(panel =>
    panel.services
      .filter(svc => !(svc.internal && source === 'edge') && !(svc.secret && source !== 'edge'))
      .map(svc => ({
        service: svc,
        primaryHost: Array.isArray(svc.host) ? svc.host[0] : svc.host,
      })),
  );

  if (allServices.length === 0) return results;

  // Sort: priority services first, then by staleness (oldest first) with jitter
  allServices.sort((a, b) => {
    const aPriority = priorityKeys?.has(a.primaryHost) ? 0 : 1;
    const bPriority = priorityKeys?.has(b.primaryHost) ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    const aScore = (lastCheckedTimes.get(a.primaryHost) ?? 0) + Math.random() * 60_000;
    const bScore = (lastCheckedTimes.get(b.primaryHost) ?? 0) + Math.random() * 60_000;
    return aScore - bScore;
  });

  // Concurrency-limited pool with ramp-up
  let inFlight = 0;
  let nextIndex = 0;
  let rampTimer: ReturnType<typeof setInterval> | undefined;

  await new Promise<void>(resolve => {
    function done() {
      if (rampTimer) clearInterval(rampTimer);
      resolve();
    }

    function tryLaunch() {
      while (nextIndex < allServices.length && inFlight < currentLimit && !budgetDone) {
        const { service, primaryHost } = allServices[nextIndex];

        // Proactive budget: stop before exceeding the cap. Always launch at
        // least one service, so a single service costing more than the whole
        // budget still gets checked rather than starving forever.
        const cost = estimateSubrequests(service, source);
        if (spent > 0 && spent + cost > budget) {
          budgetDone = true;
          break;
        }
        spent += cost;

        nextIndex++;
        inFlight++;

        runServiceChecks(service, source, previousResults).then(
          ({ checks, wwwCheck, budgetExhausted }) => {
            inFlight--;
            if (budgetExhausted) budgetDone = true;
            if (checks.length > 0) results.set(primaryHost, { checks, wwwCheck });
            if (inFlight === 0 && (nextIndex >= allServices.length || budgetDone)) return done();
            tryLaunch();
          },
          err => {
            // runServiceChecks handles errors internally, but be safe
            inFlight--;
            console.error(`Unexpected error checking ${primaryHost}:`, err);
            if (inFlight === 0 && (nextIndex >= allServices.length || budgetDone)) return done();
            tryLaunch();
          },
        );
      }

      // Nothing to launch and nothing in flight → done
      if (inFlight === 0) done();
    }

    // Ramp concurrency from start → max
    if (cfg.start < cfg.max) {
      rampTimer = setInterval(() => {
        if (currentLimit >= cfg.max) {
          clearInterval(rampTimer!);
          rampTimer = undefined;
          return;
        }
        currentLimit = Math.min(currentLimit + cfg.increment, cfg.max);
        tryLaunch(); // fill newly available slots
      }, cfg.periodMs);
    }

    tryLaunch();
  });

  console.log(`Checked ${results.size}/${allServices.length} services${budgetDone ? ' (budget exhausted)' : ''}`);
  return results;
}
