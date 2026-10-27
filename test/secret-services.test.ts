/**
 * Secret services: config validation, the socket probe against a stubbed
 * socket, and a redaction audit.
 *
 * The audit is the point. It runs a real scheduled() tick and real fetch()
 * requests with a secret service whose address and Host are distinctive
 * strings, and the probe is rigged so the origin's own responses and errors
 * quote them. Then it checks every response body, every D1 row, every console
 * line and every decrypted push payload. Neither string may appear anywhere.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAuthCookie } from '../src/auth';
import { b64u } from '../src/base64';
import { createWorker } from '../src/index';
import { addSecretServices, parseSecretServices, scrubSecret } from '../src/secret-services';
import { probeSecretOnce } from '../src/socket-probe';
import type { ConnectFn, DashboardConfig, Env, SecretProbe } from '../src/types';

/** One ordinary service beside the secret ones, small enough that the free
 *  plan's per-tick check budget never decides what gets checked. */
const config: DashboardConfig = {
  panels: [{ panel: 'Sites', services: [{ name: 'Public site', host: 'public-site.example', https: '/' }] }],
};

// ── Stub sockets ─────────────────────────────────────────────────────────────

type Behaviour =
  | { reply: string } // accept, then answer with these bytes
  | { refuse: string } // `opened` rejects with this message
  | { hang: true }; // never opens

/** A connect() whose sockets behave as `behaviour(address, port)` says, and
 *  which records every request written to it. */
function stubConnect(behaviour: (address: string, port: number) => Behaviour) {
  const written: string[] = [];
  const connect: ConnectFn = ({ hostname, port }) => {
    const b = behaviour(hostname, port);
    const opened =
      'refuse' in b
        ? Promise.reject(new Error(b.refuse))
        : 'hang' in b
          ? new Promise<never>(() => {})
          : Promise.resolve({ remoteAddress: hostname });
    opened.catch(() => {});
    const bytes = new TextEncoder().encode('reply' in b ? b.reply : '');
    return {
      opened,
      closed: Promise.resolve(),
      upgraded: false,
      secureTransport: 'off',
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          // Split the reply so the reader has to loop to find the end of the headers.
          const mid = Math.floor(bytes.length / 2);
          c.enqueue(bytes.slice(0, mid));
          c.enqueue(bytes.slice(mid));
          c.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(new TextDecoder().decode(chunk));
        },
      }),
      close: async () => {},
      startTls() {
        throw new Error('not used');
      },
    } as unknown as Socket;
  };
  return { connect, written };
}

function probe(o: Partial<SecretProbe> & Pick<SecretProbe, 'connect'>): SecretProbe {
  return {
    id: 'origin',
    kind: 'http',
    address: '192.0.2.10',
    port: 80,
    host: 'site.example',
    path: '/',
    timeout: 5,
    ...o,
  };
}

// ── Config validation ────────────────────────────────────────────────────────

describe('parseSecretServices', () => {
  const good = { id: 'helena', name: 'Origin server', address: '192.0.2.10', kind: 'http', host: 'site.example' };

  test('accepts a well-formed list, with defaults left to the probe', () => {
    const r = parseSecretServices(
      JSON.stringify([good, { id: 'db', name: 'DB port', address: 'db.internal.example', kind: 'tcp', port: 5432 }]),
    );
    expect('entries' in r && r.entries.length).toBe(2);
  });

  test('rejects bad JSON without quoting it', () => {
    const r = parseSecretServices('[{"address": "192.0.2.99", oops');
    expect(r).toEqual({ errors: ['not valid JSON'] });
  });

  test('names the entry and field but never a value', () => {
    const secretish = '198.51.100.77';
    const bad = [
      { ...good, id: 'Bad Id' },
      { ...good, id: 'x', address: `http://${secretish}/` },
      { ...good, id: 'y', host: undefined },
      { ...good, id: 'z', kind: 'tcp', path: '/' },
      { ...good, id: 'w', port: 25 },
      { ...good, id: 'v', extra: secretish },
      { ...good, id: 'u', host: `evil\r\nX: ${secretish}` },
      { ...good, id: 'helena' },
      { ...good, id: 'helena' },
    ];
    const r = parseSecretServices(JSON.stringify(bad));
    expect('errors' in r).toBe(true);
    const errors = (r as { errors: string[] }).errors;
    expect(errors.join('\n')).not.toContain(secretish);
    expect(errors.some(e => e.startsWith('entry 0: "id"'))).toBe(true);
    expect(errors.some(e => e.startsWith('entry 1: "address"'))).toBe(true);
    expect(errors.some(e => e.startsWith('entry 2: "host"'))).toBe(true);
    expect(errors.some(e => e.startsWith('entry 3: "path" only applies'))).toBe(true);
    expect(errors.some(e => e.startsWith('entry 4: "port"'))).toBe(true);
    expect(errors.some(e => e.startsWith('entry 5: unknown field "extra"'))).toBe(true);
    expect(errors.some(e => e.startsWith('entry 6: "host"'))).toBe(true);
    expect(errors.some(e => e.startsWith('entry 8: "id" is a duplicate'))).toBe(true);
  });

  test('rejects a non-array', () => {
    expect(parseSecretServices('{}')).toEqual({ errors: ['must be a JSON array of service objects'] });
  });

  test('entries join an existing panel by name, or get their own', () => {
    const { connect } = stubConnect(() => ({ hang: true }));
    const base = { panels: [{ panel: 'Sites', services: [{ host: 'site.example' }] }] };
    const out = addSecretServices(
      base,
      [
        { id: 'a', name: 'A', panel: 'Sites', address: '192.0.2.1', kind: 'tcp' },
        { id: 'b', name: 'B', address: '192.0.2.2', kind: 'tcp' },
      ],
      connect,
    );
    expect(out.panels.map(p => [p.panel, p.services.map(s => s.host)])).toEqual([
      ['Sites', ['site.example', 'secret:a']],
      ['Direct checks', ['secret:b']],
    ]);
    expect(base.panels[0].services.length).toBe(1); // the static config is untouched
  });

  test('scrubSecret hides the address and Host, case-insensitively', () => {
    expect(
      scrubSecret('connect to 192.0.2.10:80 for Site.Example failed', { address: '192.0.2.10', host: 'site.example' }),
    ).toBe('connect to [hidden]:80 for [hidden] failed');
  });
});

// ── The probe ────────────────────────────────────────────────────────────────

describe('probeSecretOnce', () => {
  test('http: a matching status is up, with the opaque URL', async () => {
    const s = stubConnect(() => ({ reply: 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>' }));
    const r = await probeSecretOnce('secret:origin', probe({ connect: s.connect }), 'edge');
    expect(r).toMatchObject({
      status: 'up',
      code: 200,
      type: 'secret',
      url: 'secret://origin',
      service: 'secret:origin',
    });
    expect(s.written[0]).toStartWith('GET / HTTP/1.1\r\nHost: site.example\r\n');
  });

  test('http: a redirect matches on Location; a wrong one is down and scrubbed', async () => {
    const ok = stubConnect(() => ({ reply: 'HTTP/1.1 301 Moved\r\nLocation: https://site.example/\r\n\r\n' }));
    const up = await probeSecretOnce('s', probe({ connect: ok.connect, redirect: 'https://site.example/' }), 'edge');
    expect(up).toMatchObject({ status: 'up', code: 301 });

    const bad = stubConnect(() => ({ reply: 'HTTP/1.1 302 Found\r\nlocation: http://192.0.2.10/login\r\n\r\n' }));
    const down = await probeSecretOnce('s', probe({ connect: bad.connect, redirect: 'https://site.example/' }), 'edge');
    expect(down?.status).toBe('down');
    expect(down?.error).toBe('Expected redirect to https://[hidden]/, got http://[hidden]/login');
  });

  test('http: an unexpected status is down', async () => {
    const s = stubConnect(() => ({ reply: 'HTTP/1.1 502 Bad Gateway\r\n\r\n' }));
    expect(await probeSecretOnce('s', probe({ connect: s.connect }), 'edge')).toMatchObject({
      status: 'down',
      code: 502,
      error: 'Expected 200, got 502',
    });
  });

  test('refused: down, with the address scrubbed from the error', async () => {
    const s = stubConnect((a, p) => ({ refuse: `connect ECONNREFUSED ${a}:${p}` }));
    const r = await probeSecretOnce('s', probe({ connect: s.connect }), 'edge');
    expect(r).toMatchObject({ status: 'down', error: 'connect ECONNREFUSED [hidden]:80' });
  });

  test('timeout: down with "Timeout"', async () => {
    const s = stubConnect(() => ({ hang: true }));
    const r = await probeSecretOnce('s', probe({ connect: s.connect, timeout: 1 }), 'edge');
    expect(r).toMatchObject({ status: 'down', error: 'Timeout' });
    expect(r!.latency).toBeGreaterThanOrEqual(900);
  });

  test('tcp: an accepted connection is up, and nothing is written', async () => {
    const s = stubConnect(() => ({ reply: '' }));
    const r = await probeSecretOnce('s', probe({ connect: s.connect, kind: 'tcp', port: 5432 }), 'edge');
    expect(r).toMatchObject({ status: 'up', code: undefined });
    expect(s.written).toEqual([]);
  });

  test('a socket out of subrequests yields null, like fetch()', async () => {
    const connect: ConnectFn = () => {
      throw new Error('Too many subrequests.');
    };
    expect(await probeSecretOnce('s', probe({ connect }), 'edge')).toBeNull();
  });
});

// ── Redaction audit ──────────────────────────────────────────────────────────

const ADDRESS = 'zq-origin-addr-4k7.example';
const HOST = 'zq-host-hdr-9w2.example';
const LEAKS = [ADDRESS, HOST];

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
/** D1 over bun:sqlite. `bind` returns a new statement, as D1's does, so a
 *  batch of binds off one prepared statement keeps each row's own values. */
function d1(db: Database): D1Database {
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...p: unknown[]) => statement(sql, p),
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
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

/** Undo RFC 8291 aes128gcm with the device's private key. */
async function decryptPush(body: Uint8Array, device: { priv: CryptoKey; pub: Uint8Array; auth: Uint8Array }) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const serverPub = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const serverKey = await crypto.subtle.importKey('raw', serverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, device.priv, 256);
  const hkdf = async (s: Uint8Array, ikm: BufferSource, info: Uint8Array, len: number) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, k, len * 8));
  };
  const enc = new TextEncoder();
  const ikm = await hkdf(
    device.auth,
    shared,
    new Uint8Array([...enc.encode('WebPush: info\x00'), ...device.pub, ...serverPub]),
    32,
  );
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\x00'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  return new TextDecoder().decode(padded.slice(0, end)); // drop the 0x02 delimiter
}

describe('redaction audit', () => {
  const PUSH_HOST = 'https://push.example/';
  const realFetch = globalThis.fetch;
  const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  let logged: string[];
  let pushBodies: Uint8Array[];

  beforeEach(() => {
    logged = [];
    pushBodies = [];
    for (const level of ['log', 'error', 'warn', 'info'] as const) {
      console[level] = (...args: unknown[]) => {
        logged.push(
          args
            .map(a => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
        );
      };
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(PUSH_HOST)) {
        pushBodies.push(new Uint8Array(init!.body as ArrayBuffer));
        return new Response(null, { status: 201 });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(console, realConsole);
  });

  test('neither the address nor the Host appears in any output', async () => {
    const sqlite = migrate();
    // The origin answers with a redirect that quotes both strings (mismatching
    // the expectation, so it lands in error text), and a second service is
    // refused with an error naming the address.
    const { connect } = stubConnect((address, port) =>
      port === 80
        ? { reply: `HTTP/1.1 302 Found\r\nLocation: http://${ADDRESS}/via/${HOST}\r\nServer: ${HOST}\r\n\r\n` }
        : { refuse: `Connection refused: ${address}:${port}` },
    );
    const secretServices = JSON.stringify([
      { id: 'origin', name: 'Origin server', address: ADDRESS, kind: 'http', host: HOST, redirect: `https://${HOST}/` },
      { id: 'db', name: 'Database port', address: ADDRESS, kind: 'tcp', port: 5432 },
    ]);

    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const vapidPriv = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d!;
    const vapidPub = b64u(new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer));

    const env = {
      PLAN: 'free',
      DB: d1(sqlite),
      SECRET_SERVICES: secretServices,
      PUBLIC_DASHBOARD: 'true',
      DASHBOARD_PASSWORD: 'pw',
      AUTH_SECRET: 'signing-secret',
      VAPID_PUBLIC_KEY: vapidPub,
      VAPID_PRIVATE_KEY: vapidPriv,
      VAPID_SUBJECT: 'mailto:test@example.com',
    } as Env;

    // A subscribed device with every service on, so the outages are pushed.
    const dk = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const device = {
      priv: dk.privateKey,
      pub: new Uint8Array((await crypto.subtle.exportKey('raw', dk.publicKey)) as ArrayBuffer),
      auth: crypto.getRandomValues(new Uint8Array(16)),
    };
    sqlite.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, is_admin, default_enabled) VALUES (?, ?, ?, 1, 1, 1)`,
      [`${PUSH_HOST}device`, b64u(device.pub), b64u(device.auth)],
    );

    const worker = createWorker({ config, connect });
    const pending: Promise<unknown>[] = [];
    const tickCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
    await worker.scheduled!(
      { scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController,
      env,
      tickCtx as unknown as ExecutionContext,
    );
    await Promise.all(pending);

    // The services were really checked and really went down.
    const rows = sqlite.query(`SELECT url, status, error FROM checks WHERE url LIKE 'secret://%' ORDER BY url`).all();
    expect(rows).toEqual([
      { url: 'secret://db', status: 'down', error: 'Connection refused: [hidden]:5432' },
      {
        url: 'secret://origin',
        status: 'down',
        error: 'Expected redirect to https://[hidden]/, got http://[hidden]/via/[hidden]',
      },
    ]);
    expect(pushBodies.length).toBeGreaterThan(0);

    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const cookie = (await buildAuthCookie(env, true)).split(';')[0];
    const bodies: string[] = [];
    const call = async (path: string, init: RequestInit = {}, asAdmin = true) => {
      const headers = new Headers(init.headers);
      if (asAdmin) headers.set('Cookie', cookie);
      const res = await worker.fetch!(
        new Request(`https://status.example${path}`, { ...init, headers }) as Request<
          unknown,
          IncomingRequestCfProperties
        >,
        env,
        ctx,
      );
      const text = await res.text();
      expect(res.status).toBeLessThan(500);
      bodies.push(`${path}\n${[...res.headers].join('\n')}\n${text}`);
      return text;
    };

    const dashboard = await call('/');
    expect(dashboard).toContain('Origin server');
    expect(dashboard).toContain('DIRECT');
    await call('/', {}, false);
    const poll = await call('/api/poll?full');
    expect(poll).toContain('secret:origin');
    await call('/api/poll', {}, false);
    await call('/api/poll?full', {}, false);
    await call('/api/history?service=secret%3Aorigin&url=secret%3A%2F%2Forigin');
    await call('/api/history?service=secret%3Aorigin&url=secret%3A%2F%2Forigin', {}, false);
    expect(await call('/api/errors')).toContain('secret://origin');
    await call('/errors');
    await call('/errors?service=secret%3Aorigin');
    await call('/subscriptions');
    await call('/api/subscriptions');
    await call('/api/notification-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: `${PUSH_HOST}device` }),
    });

    const pushes = await Promise.all(pushBodies.map(b => decryptPush(b, device)));
    expect(pushes.join('\n')).toContain('Origin server');

    const tables = (
      sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map(t => `${t.name}: ${JSON.stringify(sqlite.query(`SELECT * FROM "${t.name}"`).all())}`);

    const outputs = { responses: bodies, d1: tables, console: logged, pushes };
    for (const [where, texts] of Object.entries(outputs)) {
      for (const leak of LEAKS) {
        const hit = texts.find(t => t.toLowerCase().includes(leak.toLowerCase()));
        expect(hit ? `${where} leaks ${leak}: ${hit.slice(0, 200)}` : null).toBeNull();
      }
    }
  });

  test('a bad secret is logged without its contents, and the rest of the tick runs', async () => {
    const sqlite = migrate();
    const env = { PLAN: 'free', DB: d1(sqlite), SECRET_SERVICES: `[{"id":"x","address":"${ADDRESS}"}]` } as Env;
    const worker = createWorker({ config, connect: stubConnect(() => ({ hang: true })).connect });
    const pending: Promise<unknown>[] = [];
    await worker.scheduled!(
      { scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController,
      env,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(pending);

    expect(logged.some(l => l.startsWith('SECRET_SERVICES is invalid'))).toBe(true);
    expect(logged.join('\n')).not.toContain(ADDRESS);
    const checked = sqlite.query(`SELECT COUNT(*) AS n FROM checks`).get() as { n: number };
    expect(checked.n).toBeGreaterThan(0); // the static services were still checked
  });

  test('without the secret, nothing changes', async () => {
    const sqlite = migrate();
    let connected = false;
    const worker = createWorker({
      config,
      connect: () => {
        connected = true;
        throw new Error('should not connect');
      },
    });
    const pending: Promise<unknown>[] = [];
    await worker.scheduled!(
      { scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController,
      { PLAN: 'free', DB: d1(sqlite) } as Env,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    expect(connected).toBe(false);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM checks WHERE type = 'secret'`).get()).toEqual({ n: 0 });
  });
});
