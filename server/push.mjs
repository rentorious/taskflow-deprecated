// Web Push with nothing but node:crypto. VAPID (RFC 8292) tells the push service who
// we are; aes128gcm (RFC 8291 over RFC 8188) keeps the service from reading what we
// send. One subscription row per browser that asked, bound to the person signed in
// there; the browser's keys stay the browser's.
//
// Sends are best-effort and never run inside a transaction: a push service that is
// slow or gone must not hold up a job report. A service that says the subscription
// is gone (404, 410) gets it deleted; one that keeps failing is dropped after a while.
//
//   node server/push.mjs generate-keys     print a fresh VAPID pair for the environment

import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

const RECORD_SIZE = 4096;
const JWT_TTL_S = 12 * 60 * 60; // the push service accepts up to 24 h; half of that leaves clock skew room
const SEND_TIMEOUT_MS = 10_000;
const MAX_PLAINTEXT = 3600; // services take 4 KB bodies; the header, the tag and the delimiter need the rest
const DROP_AFTER_FAILURES = 20;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const fail = (status, message) => Object.assign(new Error(message), { status });
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64u = (text) => Buffer.from(String(text ?? ''), 'base64url');
const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

/** A fresh pair, as the environment wants it: the raw P-256 point and scalar, base64url. */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])), privateKey: jwk.d };
}

/**
 * The key objects behind a configured pair. Throws, with a message fit for the config
 * error, when the pair is malformed or the point is not the scalar's.
 */
export function vapidKeys({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  const priv = fromB64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point, base64url.');
  if (priv.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be a 32-byte P-256 scalar, base64url.');
  const ecdh = createECDH('prime256v1');
  try { ecdh.setPrivateKey(priv); } catch { throw new Error('VAPID_PRIVATE_KEY is not a valid P-256 scalar.'); }
  // Derived from the scalar, not read back from what was given: a mismatched pair signs tokens nobody can verify.
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID_PUBLIC_KEY is not the public key of VAPID_PRIVATE_KEY.');
  const privateKeyObject = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: b64u(priv) }, format: 'jwk' });
  return { publicKey: b64u(pub), privateKeyObject };
}

/** `Authorization: vapid t=<jwt>, k=<key>` for the push service that serves one endpoint (RFC 8292). */
export function vapidAuthorization({ endpoint, subject, keys, now = Date.now() }) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + JWT_TTL_S, sub: subject }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKeyObject, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * RFC 8291: one message for one subscription, as the body of the push request.
 * @param {Buffer|string} plaintext
 * @param {{p256dh: string, auth: string}} subscription  the browser's public key and 16-byte secret, base64url
 * @param {{senderPrivateKey?: Buffer, salt?: Buffer}} [fixed]  pinned by a test against the RFC's vector; fresh otherwise
 */
export function encrypt(plaintext, { p256dh, auth }, fixed = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh is not a 65-byte P-256 point.');
  if (authSecret.length !== 16) throw new Error('auth is not a 16-byte secret.');
  const text = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  if (text.length > MAX_PLAINTEXT) throw new Error(`The notification is too large: ${text.length} bytes, ${MAX_PLAINTEXT} at most.`);

  const ecdh = createECDH('prime256v1');
  if (fixed.senderPrivateKey) ecdh.setPrivateKey(fixed.senderPrivateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed.salt ?? randomBytes(16);

  const ikm = hkdf(ecdh.computeSecret(uaPublic), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so the plaintext ends with the last-record delimiter and no padding.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([text, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/**
 * @param {object} [options]
 * @param {{publicKey: string, privateKeyObject: object}|null} [options.keys]  from vapidKeys(); null means push is off
 * @param {string} [options.subject]  mailto: or https: contact the push service may use
 * @param {Function} [options.fetch]
 */
export function createPusher({ keys = null, subject = null, fetch = globalThis.fetch } = {}) {
  const enabled = Boolean(keys);
  /** @returns {Promise<{ok: boolean, status: number, gone: boolean, error?: string}>} never throws for the service's sake */
  async function send(subscription, payload, { ttl = 24 * 60 * 60, urgency = 'high' } = {}) {
    if (!enabled) return { ok: false, status: 0, gone: false, error: 'push is not configured' };
    let body;
    try { body = encrypt(JSON.stringify(payload), subscription); } catch (error) { return { ok: false, status: 0, gone: true, error: error.message }; }
    const headers = {
      TTL: String(ttl), Urgency: urgency,
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
      Authorization: vapidAuthorization({ endpoint: subscription.endpoint, subject, keys }),
    };
    try {
      const res = await fetch(subscription.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
    } catch (error) {
      return { ok: false, status: 0, gone: false, error: error.message };
    }
  }
  return { enabled, publicKey: keys?.publicKey ?? null, subject, send };
}

// -- the rows ----------------------------------------------------------------------------

function checkEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint ?? '')); } catch { throw fail(400, 'A subscription needs an endpoint URL.'); }
  // Push services are https; a loopback http one is a test's stand-in.
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw fail(400, 'A push endpoint is an https URL.');
  if (url.href.length > 2000) throw fail(400, 'That endpoint is too long.');
  return url.href;
}

/** The browser said what it subscribed to; keep it, under whoever is signed in there now. */
export async function saveSubscription(db, { userId, endpoint, keys, userAgent = '' }) {
  const href = checkEndpoint(endpoint);
  const p256dh = String(keys?.p256dh ?? '');
  const auth = String(keys?.auth ?? '');
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || fromB64u(p256dh).length !== 65 || fromB64u(p256dh)[0] !== 4 || !/^[A-Za-z0-9_-]+$/.test(auth) || fromB64u(auth).length !== 16) {
    throw fail(400, 'The subscription keys are not a P-256 point and a 16-byte secret.');
  }
  await db.query(
    `insert into push_subscription (user_id, endpoint, p256dh, auth, user_agent) values ($1, $2, $3, $4, $5)
     on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, last_used_at = now(), failures = 0`,
    [userId, href, p256dh, auth, String(userAgent ?? '').slice(0, 300)],
  );
  return { ok: true };
}

export async function deleteSubscription(db, { userId, endpoint }) {
  const { rowCount } = await db.query('delete from push_subscription where user_id = $1 and endpoint = $2', [userId, String(endpoint ?? '')]);
  return { removed: rowCount };
}

export async function countSubscriptions(db, { userId }) {
  return Number((await db.query('select count(*) as n from push_subscription where user_id = $1', [userId])).rows[0].n);
}

/**
 * Send one notification to every browser of the given people. Returns what happened;
 * it never throws for a push service's sake, so a caller may fire and forget it.
 * @param {{title: string, body: string, url: string, tag?: string}} payload  what the service worker shows and opens
 */
export async function notifyUsers(db, pusher, { userIds, payload, ttl }) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!pusher.enabled || !ids.length) return { sent: 0, gone: 0, failed: 0 };
  const { rows } = await db.query('select id, endpoint, p256dh, auth from push_subscription where user_id = any($1::bigint[])', [ids]);
  const outcome = { sent: 0, gone: 0, failed: 0 };
  await Promise.all(rows.map(async (row) => {
    const result = await pusher.send(row, payload, { ttl });
    if (result.ok) {
      outcome.sent += 1;
      await db.query('update push_subscription set last_used_at = now(), failures = 0 where id = $1', [row.id]);
    } else if (result.gone) {
      outcome.gone += 1;
      await db.query('delete from push_subscription where id = $1', [row.id]);
    } else {
      outcome.failed += 1;
      await db.query('update push_subscription set failures = failures + 1 where id = $1', [row.id]);
      await db.query('delete from push_subscription where id = $1 and failures >= $2', [row.id, DROP_AFTER_FAILURES]);
    }
  }));
  return outcome;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === 'generate-keys') {
  const pair = generateVapidKeys();
  process.stdout.write(`VAPID_PUBLIC_KEY=${pair.publicKey}\nVAPID_PRIVATE_KEY=${pair.privateKey}\n`);
}
