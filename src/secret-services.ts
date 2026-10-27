/**
 * Secret services: monitored, with public uptime stats, but their address is
 * never published.
 *
 * The motivating case is an origin server behind Cloudflare's proxy. Checking
 * the public hostname only proves the proxy answers; checking the origin
 * directly needs its real IP, and putting that IP in a public repo or on a
 * public page would undo what the proxy hides. So the list lives in a Worker
 * secret, `SECRET_SERVICES`, and each entry becomes an ordinary service whose
 * host is the opaque `secret:<id>`. Everything downstream (status, history,
 * charts, uptime, transitions, notification keys) only ever sees that id and
 * the display name.
 *
 * Workers can't fetch() an IP (403), and TLS to an IP fails certificate
 * verification ("IP address mismatch", even with `expectedServerHostname`).
 * So the two probe kinds are plain HTTP/1.1 over a socket with a `Host`
 * header, and a bare TCP connect. See src/socket-probe.ts.
 */

import type { ConnectFn, DashboardConfig, PanelConfig, SecretProbe, ServiceConfig } from './types';

/** One entry of the `SECRET_SERVICES` JSON array. */
export interface SecretServiceEntry {
  /** Opaque id: lowercase letters, digits and dashes. Keys become `secret:<id>`. */
  id: string;
  /** Public display name. Don't put the address in it. */
  name: string;
  /** Panel to show it in: an existing panel's name, or a new one. Default "Direct checks". */
  panel?: string;
  labels?: string[];
  /** IP or hostname to connect to. Never shown anywhere. */
  address: string;
  /** Default 80 for `http`, 443 for `tcp`. */
  port?: number;
  kind: 'http' | 'tcp';
  /** `Host` header, required for `http`. Never shown anywhere. */
  host?: string;
  /** `http` only. Default "/". */
  path?: string;
  /** `http` only. Expected status, default 200 (any 2xx). */
  expect?: number;
  /** `http` only. Expected `Location` substring, for an origin that redirects. */
  redirect?: string;
  /** Seconds, 1–30. Default 10. */
  timeout?: number;
}

export const SECRET_HOST_PREFIX = 'secret:';
export const SECRET_URL_PREFIX = 'secret://';
const DEFAULT_PANEL = 'Direct checks';

const ALLOWED_KEYS = new Set([
  'id',
  'name',
  'panel',
  'labels',
  'address',
  'port',
  'kind',
  'host',
  'path',
  'expect',
  'redirect',
  'timeout',
]);
const HTTP_ONLY_KEYS = ['host', 'path', 'expect', 'redirect'] as const;

export function isSecretHost(host: string | undefined): boolean {
  return host?.startsWith(SECRET_HOST_PREFIX) ?? false;
}

/** No whitespace or control characters: these go into a request line and a
 *  header, so a CR/LF would be header injection. */
const TOKEN = /^[^\s\x00-\x1f\x7f]+$/;

/**
 * Parse and validate the secret. Returns the entries, or the list of problems.
 * Problems name the entry index and the field, **never a value**: the whole
 * point of the secret is that its contents don't reach logs.
 */
export function parseSecretServices(raw: string): { entries: SecretServiceEntry[] } | { errors: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // JSON.parse's message quotes the input, so it can't be passed on.
    return { errors: ['not valid JSON'] };
  }
  if (!Array.isArray(data)) return { errors: ['must be a JSON array of service objects'] };

  const errors: string[] = [];
  const ids = new Set<string>();
  const entries: SecretServiceEntry[] = [];

  data.forEach((item: unknown, i) => {
    const at = `entry ${i}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const e = item as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!ALLOWED_KEYS.has(key)) errors.push(`${at}: unknown field "${key.slice(0, 40)}"`);
    }
    const isString = (k: string, max: number) => typeof e[k] === 'string' && e[k] !== '' && e[k].length <= max;
    const isInt = (k: string, min: number, max: number) =>
      Number.isInteger(e[k]) && (e[k] as number) >= min && (e[k] as number) <= max;

    if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(e.id)) {
      errors.push(`${at}: "id" must be 1–40 lowercase letters, digits or dashes`);
    } else if (ids.has(e.id)) {
      errors.push(`${at}: "id" is a duplicate`);
    } else {
      ids.add(e.id);
    }
    if (!isString('name', 80)) errors.push(`${at}: "name" must be a non-empty string (max 80)`);
    if (e.panel !== undefined && !isString('panel', 80)) errors.push(`${at}: "panel" must be a non-empty string`);
    if (e.labels !== undefined && !(Array.isArray(e.labels) && e.labels.every(l => typeof l === 'string'))) {
      errors.push(`${at}: "labels" must be an array of strings`);
    }
    if (!isString('address', 253) || !TOKEN.test(e.address as string) || /[/@]/.test(e.address as string)) {
      errors.push(`${at}: "address" must be a bare IP or hostname`);
    }
    if (e.port !== undefined && (!isInt('port', 1, 65535) || e.port === 25)) {
      errors.push(`${at}: "port" must be an integer 1–65535 (not 25, which Workers block)`);
    }
    if (e.kind !== 'http' && e.kind !== 'tcp') errors.push(`${at}: "kind" must be "http" or "tcp"`);
    if (e.timeout !== undefined && !isInt('timeout', 1, 30)) errors.push(`${at}: "timeout" must be 1–30 seconds`);

    if (e.kind === 'http') {
      if (!isString('host', 253) || !TOKEN.test(e.host as string)) {
        errors.push(`${at}: "host" (the Host header) is required for kind "http"`);
      }
      if (
        e.path !== undefined &&
        (!isString('path', 2000) || !TOKEN.test(e.path as string) || !(e.path as string).startsWith('/'))
      ) {
        errors.push(`${at}: "path" must start with "/" and contain no spaces`);
      }
      if (e.expect !== undefined && !isInt('expect', 100, 599)) errors.push(`${at}: "expect" must be a status 100–599`);
      if (e.redirect !== undefined && !isString('redirect', 2000)) {
        errors.push(`${at}: "redirect" must be a non-empty string`);
      }
    } else if (e.kind === 'tcp') {
      for (const key of HTTP_ONLY_KEYS) {
        if (e[key] !== undefined) errors.push(`${at}: "${key}" only applies to kind "http"`);
      }
    }
    entries.push(e as unknown as SecretServiceEntry);
  });

  return errors.length > 0 ? { errors } : { entries };
}

function toProbe(e: SecretServiceEntry, connect: ConnectFn): SecretProbe {
  return {
    id: e.id,
    kind: e.kind,
    address: e.address,
    port: e.port ?? (e.kind === 'http' ? 80 : 443),
    host: e.host,
    path: e.path ?? '/',
    expect: e.expect,
    redirect: e.redirect,
    timeout: e.timeout ?? 10,
    connect,
  };
}

/** The config with each secret entry added as a service, in its panel. */
export function addSecretServices(
  config: DashboardConfig,
  entries: SecretServiceEntry[],
  connect: ConnectFn,
): DashboardConfig {
  if (entries.length === 0) return config;
  const panels: PanelConfig[] = config.panels.map(p => ({ ...p, services: [...p.services] }));
  for (const e of entries) {
    const service: ServiceConfig = {
      name: e.name,
      host: `${SECRET_HOST_PREFIX}${e.id}`,
      labels: e.labels,
      secret: toProbe(e, connect),
    };
    const name = e.panel ?? DEFAULT_PANEL;
    let panel = panels.find(p => p.panel === name);
    if (!panel) {
      panel = { panel: name, services: [] };
      panels.push(panel);
    }
    panel.services.push(service);
  }
  return { ...config, panels };
}

/** Replace the address and Host in error text. Socket errors and a mismatched
 *  `Location` can both quote them. */
export function scrubSecret(text: string, probe: Pick<SecretProbe, 'address' | 'host'>): string {
  let out = text;
  for (const needle of [probe.address, probe.host]) {
    if (!needle) continue;
    out = out.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[hidden]');
  }
  return out;
}

/**
 * Builds the effective config for a worker: the static config plus whatever
 * `SECRET_SERVICES` holds. Parses once per distinct secret value, so a warm
 * isolate doesn't re-parse per request, and logs a bad secret once rather than
 * on every request. A bad secret disables secret services only; everything
 * else keeps running.
 */
export function createSecretServiceResolver(config: DashboardConfig, connect: ConnectFn) {
  let lastRaw: string | undefined;
  let lastConfig = config;
  return (raw: string | undefined): DashboardConfig => {
    if (!raw) return config;
    if (raw === lastRaw) return lastConfig;
    lastRaw = raw;
    const parsed = parseSecretServices(raw);
    if ('errors' in parsed) {
      console.error(`SECRET_SERVICES is invalid, so secret services are off: ${parsed.errors.join('; ')}`);
      lastConfig = config;
    } else {
      lastConfig = addSecretServices(config, parsed.entries, connect);
    }
    return lastConfig;
  };
}
