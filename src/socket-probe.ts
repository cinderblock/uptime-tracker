/**
 * One direct check of a secret service over a raw socket.
 *
 * `http`: plain HTTP/1.1 to `address:port` with the configured `Host` header.
 * Only the status line and headers are read, then the socket is closed.
 * `tcp`: the port accepted a connection.
 *
 * Every result carries `url: secret://<id>` and an error with the address and
 * Host scrubbed out, so nothing this returns can reveal where it connected.
 */

import { SECRET_URL_PREFIX, scrubSecret } from './secret-services';
import type { CheckResult, SecretProbe } from './types';

/** Enough for a status line and headers; anything longer is cut off. */
const MAX_HEAD_BYTES = 16 * 1024;

class TimeoutError extends Error {}

type Outcome = { status: 'up'; code?: number } | { status: 'down'; code?: number; error: string };

function validateHttp(probe: SecretProbe, code: number, location: string | null): Outcome {
  if (probe.redirect) {
    if (code >= 300 && code < 400) {
      if (location && location.includes(probe.redirect)) return { status: 'up', code };
      return { status: 'down', code, error: `Expected redirect to ${probe.redirect}, got ${location}` };
    }
    return { status: 'down', code, error: `Expected redirect (3xx), got ${code}` };
  }
  const expected = probe.expect ?? 200;
  if (code === expected || (expected === 200 && code >= 200 && code < 300)) return { status: 'up', code };
  return { status: 'down', code, error: `Expected ${expected}, got ${code}` };
}

/** Read until the end of the headers (or the cap, or EOF), then parse the
 *  status code and Location. */
async function readHead(readable: ReadableStream<Uint8Array>): Promise<{ code: number; location: string | null }> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let head = '';
  try {
    while (head.length < MAX_HEAD_BYTES && !head.includes('\r\n\r\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      head += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const [statusLine, ...lines] = head.split('\r\n');
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine ?? '');
  if (!match) throw new Error(head ? 'Not an HTTP response' : 'Connection closed with no response');
  const locationLine = lines.find(l => /^location:/i.test(l));
  return { code: Number(match[1]), location: locationLine ? locationLine.slice(9).trim() : null };
}

async function attempt(probe: SecretProbe, signal: Promise<never>): Promise<Outcome> {
  const socket = await Promise.race([
    probe.connect({ hostname: probe.address, port: probe.port }, { secureTransport: 'off', allowHalfOpen: false }),
    signal,
  ]);
  try {
    await Promise.race([socket.opened, signal]);
    if (probe.kind === 'tcp') return { status: 'up' };

    const writer = socket.writable.getWriter();
    const request =
      `GET ${probe.path} HTTP/1.1\r\nHost: ${probe.host}\r\nUser-Agent: uptime-tracker\r\n` +
      `Accept: */*\r\nConnection: close\r\n\r\n`;
    await Promise.race([writer.write(new TextEncoder().encode(request)), signal]);
    writer.releaseLock();
    const { code, location } = await Promise.race([readHead(socket.readable), signal]);
    return validateHttp(probe, code, location);
  } finally {
    socket.close().catch(() => {});
  }
}

/** One check. Null means the Worker is out of subrequests, as with fetch(). */
export async function probeSecretOnce(
  serviceName: string,
  probe: SecretProbe,
  source: 'edge' | 'browser',
): Promise<CheckResult | null> {
  const startTime = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError('Timeout')), probe.timeout * 1000);
  });
  signal.catch(() => {}); // a race that already settled mustn't surface it as unhandled

  let outcome: Outcome;
  try {
    outcome = await attempt(probe, signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('Too many subrequests')) return null;
    outcome = { status: 'down', error: err instanceof TimeoutError ? 'Timeout' : message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return {
    service: serviceName,
    url: `${SECRET_URL_PREFIX}${probe.id}`,
    type: 'secret',
    status: outcome.status,
    code: outcome.code,
    latency: Date.now() - startTime,
    error: outcome.status === 'down' ? scrubSecret(outcome.error, probe) : undefined,
    timestamp: Date.now(),
    source,
  };
}
