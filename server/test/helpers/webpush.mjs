// The other end of Web Push, for tests: a browser's keys and its side of RFC 8291
// (decrypting what the server sent), and a stand-in push service that records what
// reaches it and answers 201, or 410 for an endpoint under /gone/.

import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** What a browser would hand the page from pushManager.subscribe(), plus the private key it keeps. */
export function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey().toString('base64url'), p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

/** The receiver's half of RFC 8291: one aes128gcm record, back to the plaintext. */
export function decrypt(body, { privateKey, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  const uaPublic = ecdh.getPublicKey();
  const ikm = hkdf(ecdh.computeSecret(asPublic), Buffer.from(auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  if (padded[end - 1] !== 2) throw new Error('the last record does not end in the 0x02 delimiter');
  return padded.subarray(0, end - 1);
}

export async function fakePushService() {
  const delivered = [];
  let gone = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url.includes('/gone/')) { gone += 1; res.writeHead(410); res.end(); return; }
      delivered.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201);
      res.end();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  let cursor = 0;
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    delivered,
    get gone() { return gone; },
    /** The next delivery not yet looked at, within `timeoutMs`. */
    async next(timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (delivered.length > cursor) return delivered[cursor++];
        await sleep(20);
      }
      throw new Error('no push arrived in time');
    },
    close: () => new Promise((done) => server.close(done)),
  };
}
