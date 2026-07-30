/**
 * Web Push notification sender — RFC 8291 (aes128gcm payload encryption) + RFC 8292 (VAPID auth)
 *
 * VAPID key format expected in environment variables:
 *   VAPID_PUBLIC_KEY  — base64url-encoded 65-byte uncompressed P-256 EC point (0x04 || x || y)
 *   VAPID_PRIVATE_KEY — base64url-encoded 32-byte raw P-256 private key scalar (d)
 *   VAPID_SUBJECT     — "mailto:…" or HTTPS URL identifying the sender
 *
 * Keys can be generated with:  bunx web-push generate-vapid-keys
 */

import { b64d, b64u } from './base64';

/** HKDF-SHA-256 (Extract + Expand in one call via Web Crypto) */
async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

/**
 * Encrypt a Web Push payload per RFC 8291 (Content-Encoding: aes128gcm).
 * Returns the raw request body bytes to POST to the push endpoint.
 */
async function encryptPayload(plaintext: string, p256dh: string, auth: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const pt = enc.encode(plaintext);
  const subscriberPub = b64d(p256dh); // 65-byte uncompressed EC point
  const authSecret = b64d(auth); // 16-byte auth secret

  // Import subscriber's ECDH public key
  const subscriberKey = await crypto.subtle.importKey(
    'raw',
    subscriberPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // Generate ephemeral server ECDH key pair
  const serverKp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const serverPub = new Uint8Array((await crypto.subtle.exportKey('raw', serverKp.publicKey)) as ArrayBuffer); // 65 bytes

  // ECDH shared secret (32 bytes = x-coordinate of shared point)
  // Note: Cloudflare Workers types use `$public` as a workaround for the TS reserved keyword,
  // but the Web Crypto runtime expects the standard `public` property (RFC 6090).
  const ecdhBits = await crypto.subtle.deriveBits(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: 'ECDH', public: subscriberKey } as any,
    serverKp.privateKey,
    256,
  );

  // Random salt for content encryption record (16 bytes)
  const contentSalt = crypto.getRandomValues(new Uint8Array(16));

  // IKM = HKDF(salt=authSecret, IKM=ecdhBits, info="WebPush: info\0" || ua_pub || as_pub, L=32)
  const ikmInfo = new Uint8Array([...enc.encode('WebPush: info\x00'), ...subscriberPub, ...serverPub]);
  const ikm = await hkdf(authSecret, ecdhBits, ikmInfo, 32);

  // Content-encryption key (16 bytes) and nonce (12 bytes) derived from content salt
  const cek = await hkdf(contentSalt, ikm, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(contentSalt, ikm, enc.encode('Content-Encoding: nonce\x00'), 12);

  // Encrypt with AES-128-GCM; pad with 0x02 (final-record delimiter per RFC 8291 §4)
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const padded = new Uint8Array(pt.length + 1);
  padded.set(pt);
  padded[pt.length] = 0x02;
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded));

  // Build aes128gcm content-encoding header:
  //   salt(16) | rs(4, BE) | idlen(1) | server_pub(65) | ciphertext
  const rs = 4096;
  const out = new Uint8Array(16 + 4 + 1 + 65 + cipher.length);
  const view = new DataView(out.buffer);
  out.set(contentSalt, 0);
  view.setUint32(16, rs, false);
  view.setUint8(20, 65); // key ID length = server public key length
  out.set(serverPub, 21);
  out.set(cipher, 86);
  return out.buffer;
}

/**
 * Create a VAPID JWT (RFC 8292) signed with ES256.
 * privateKeyB64u = base64url raw 32-byte P-256 scalar d
 * publicKeyB64u  = base64url 65-byte uncompressed P-256 point (0x04 || x || y)
 */
async function vapidJWT(
  endpoint: string,
  subject: string,
  privateKeyB64u: string,
  publicKeyB64u: string,
): Promise<string> {
  const enc = new TextEncoder();
  const audience = new URL(endpoint).origin;

  const headerEnc = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payloadEnc = b64u(
    enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 43200, sub: subject })),
  );
  const sigInput = `${headerEnc}.${payloadEnc}`;

  // Build JWK from raw private scalar + uncompressed public key
  const pub = b64d(publicKeyB64u);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: privateKeyB64u,
    x: b64u(pub.slice(1, 33)),
    y: b64u(pub.slice(33, 65)),
    ext: true,
    key_ops: ['sign'],
  };

  const sigKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // Web Crypto returns raw r||s (IEEE P1363) format, which is exactly what JWT ES256 needs.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigKey, enc.encode(sigInput)),
  );
  return `${sigInput}.${b64u(sig)}`;
}

export interface PushConfig {
  /** base64url-encoded 65-byte uncompressed P-256 public key */
  publicKey: string;
  /** base64url-encoded 32-byte raw P-256 private key scalar */
  privateKey: string;
  /** "mailto:…" or HTTPS URL identifying the sender */
  subject: string;
}

export interface PushResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Send a Web Push notification to one subscriber.
 * `data` is serialised as JSON and encrypted in the request body.
 * Returns { ok: true } on HTTP 200/201, otherwise { ok: false, status, error }.
 */
export async function sendPushNotification(
  endpoint: string,
  p256dh: string,
  auth: string,
  data: Record<string, unknown>,
  vapid: PushConfig,
  urgency: 'very-low' | 'low' | 'normal' | 'high' = 'normal',
): Promise<PushResult> {
  try {
    const body = await encryptPayload(JSON.stringify(data), p256dh, auth);
    const jwt = await vapidJWT(endpoint, vapid.subject, vapid.privateKey, vapid.publicKey);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: `vapid t=${jwt},k=${vapid.publicKey}`,
        TTL: '86400',
        Urgency: urgency,
      },
      body,
    });

    if (res.status !== 200 && res.status !== 201) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
