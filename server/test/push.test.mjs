// Web Push: the bytes match RFC 8291's own example, the VAPID token verifies with the
// public key, and the events that matter reach the one browser that asked, through a
// stand-in push service that can only see ciphertext.

import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { specs } from '../../test/fixtures/specs.mjs';
import { roundTrip } from '../../test/helpers/trip.mjs';
import { readConfig } from '../config.mjs';
import { newPullRequests } from '../ingest.mjs';
import { encrypt, generateVapidKeys, vapidAuthorization, vapidKeys } from '../push.mjs';
import { profile, startHosted } from './helpers/hosted.mjs';
import { browserKeys, decrypt, fakePushService } from './helpers/webpush.mjs';

// RFC 8291, Appendix A and Section 5.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test("RFC 8291 Appendix A: the RFC's keys and salt give the RFC's bytes, and the browser side reads them back", () => {
  const body = encrypt(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { senderPrivateKey: Buffer.from(RFC.asPrivate, 'base64url'), salt: Buffer.from(RFC.salt, 'base64url') });
  assert.equal(body.toString('base64url'), RFC.body);
  assert.equal(decrypt(Buffer.from(RFC.body, 'base64url'), { privateKey: RFC.uaPrivate, auth: RFC.auth }).toString('utf8'), RFC.plaintext);
  // Fresh keys and salt every other time: two sends of one text never look alike.
  const once = encrypt(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth });
  assert.notEqual(once.toString('base64url'), RFC.body);
  assert.equal(decrypt(once, { privateKey: RFC.uaPrivate, auth: RFC.auth }).toString('utf8'), RFC.plaintext);
  assert.throws(() => encrypt('x'.repeat(4000), { p256dh: RFC.uaPublic, auth: RFC.auth }), /too large/);
});

test('VAPID: an ES256 token for the push service origin, verifiable with the public key given beside it', () => {
  const pair = generateVapidKeys();
  const keys = vapidKeys(pair);
  const header = vapidAuthorization({ endpoint: 'https://push.example.net/send/abc?x=1', subject: 'mailto:dev@example.com', keys, now: 1_700_000_000_000 });
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], pair.publicKey);
  const [h, c, s] = m[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { aud: 'https://push.example.net', exp: 1_700_000_000 + 12 * 3600, sub: 'mailto:dev@example.com' });
  const raw = Buffer.from(pair.publicKey, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
  assert.throws(() => vapidKeys({ publicKey: generateVapidKeys().publicKey, privateKey: pair.privateKey }), /not the public key of/);
  assert.throws(() => vapidKeys({ publicKey: 'short', privateKey: pair.privateKey }), /65-byte/);
});

test('config: both keys or none, only with sign-in, with a contact that is a mailto: or https:', () => {
  const base = { DATABASE_URL: 'postgres://x/y', PUBLIC_URL: 'https://flow.example.com', PORT: '8080', GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 'secret', SESSION_SECRET: 's'.repeat(32), ADMIN_GITHUB_LOGINS: 'ann' };
  const pair = generateVapidKeys();
  const refused = (env, pattern) => assert.throws(() => readConfig(env), (e) => e.config === true && pattern.test(e.message));
  assert.equal(readConfig(base).push, null);
  assert.deepEqual(readConfig({ ...base, VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey }).push, { ...pair, subject: 'https://flow.example.com' });
  assert.equal(readConfig({ ...base, VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: 'mailto:dev@example.com' }).push.subject, 'mailto:dev@example.com');
  refused({ ...base, VAPID_PUBLIC_KEY: pair.publicKey }, /half configured.*VAPID_PRIVATE_KEY/);
  refused({ ...base, VAPID_PUBLIC_KEY: generateVapidKeys().publicKey, VAPID_PRIVATE_KEY: pair.privateKey }, /not the public key of/);
  refused({ ...base, VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: 'ognjen' }, /mailto: address or an https: URL/);
  refused({ DATABASE_URL: 'postgres://x/y', PUBLIC_URL: 'http://127.0.0.1:3900', VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey }, /needs sign-in/);
});

test('a push brings news of a pull request only when its url is new to the server', () => {
  const before = { batchFiles: { 'batch-1': { data: { pr_url: 'https://github.com/h/b/pull/1' } }, 'batch-2': { data: { pr_url: null } } } };
  const now = { batchFiles: { 'batch-1': { data: { pr_url: 'https://github.com/h/b/pull/1' } }, 'batch-2': { data: { pr_url: 'https://github.com/h/b/pull/2' } }, 'batch-3': { data: { pr_url: 'https://github.com/h/b/pull/3' } }, 'batch-4': { data: null }, 'batch-5': { data: { pr_url: 'javascript:alert(1)' } } } };
  assert.deepEqual(newPullRequests(now, before), [{ batchKey: 'batch-2', prUrl: 'https://github.com/h/b/pull/2' }, { batchKey: 'batch-3', prUrl: 'https://github.com/h/b/pull/3' }]);
  assert.deepEqual(newPullRequests(now, now), []);
  assert.deepEqual(newPullRequests({ batchFiles: {} }, null), []);
});

describe('notifications over the wire', () => {
  let service; let h; let ann; let bob; let annToken; let machine; let pair; let phone;
  const api = (path) => `/api/p/harbor/${path}`;
  const asToken = (token, path, { method = 'POST', json } = {}) => fetch(new URL(path.startsWith('/') ? path : api(path), h.origin), { method, headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const runner = (path, json) => asToken(annToken, path, { json: { machineId: machine, ...json } });
  const subscription = (keys, path) => ({ endpoint: `${service.origin}${path}`, expirationTime: null, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: 'a test browser' });
  const rows = async () => (await h.db.query('select endpoint, user_id from push_subscription order by id')).rows;
  const read = (delivery, keys) => JSON.parse(decrypt(delivery.body, keys).toString('utf8'));

  before(async () => {
    service = await fakePushService();
    pair = generateVapidKeys();
    h = await startHosted({ admins: ['ann'], push: { ...pair, subject: 'mailto:dev@example.com' } });
    ann = h.browser(); await ann.signIn(profile('ann'));
    await ann.post('/settings/projects', { form: { id: 'harbor', name: 'Harbor Books' } });
    await ann.post('/settings/members/invite', { form: { project: 'harbor', login: 'bob', role: 'developer' } });
    bob = h.browser(); await bob.signIn(profile('bob'));
    annToken = /tfp_[A-Za-z0-9_-]+/.exec(await (await ann.post('/settings/tokens', { form: { label: 'laptop' } })).text())[0];
    machine = (await (await asToken(annToken, 'machines', { json: { name: 'laptop', kinds: ['implement'] } })).json()).machine.id;
    phone = browserKeys();
  });
  after(async () => { await h?.close().catch(() => {}); await service?.close(); });

  test('api/me offers the key; a browser session subscribes; a token, a cross-site page and a stranger cannot touch it', async () => {
    const me = await (await ann.get('/p/harbor/u/ann/api/me')).json();
    assert.deepEqual(me.push, { available: true, publicKey: pair.publicKey });

    let res = await asToken(annToken, '/api/push/subscriptions', { json: subscription(phone, '/send/ann-phone') });
    assert.equal(res.status, 403, 'a token is not a browser');
    res = await ann.post('/api/push/subscriptions', { json: subscription(phone, '/send/ann-phone'), origin: false });
    assert.equal(res.status, 403, 'no Origin: not a page of ours');
    res = await ann.post('/api/push/subscriptions', { json: { ...subscription(phone, '/send/ann-phone'), keys: { p256dh: 'AAAA', auth: phone.auth } } });
    assert.equal(res.status, 400);
    res = await ann.post('/api/push/subscriptions', { json: { ...subscription(phone, '/send/ann-phone'), endpoint: 'https://push.example.net/x' } });
    assert.equal(res.status, 200, 'an https endpoint anywhere is a real one');
    res = await ann.post('/api/push/subscriptions', { json: subscription(phone, '/send/ann-phone') });
    assert.equal(res.status, 200, await res.text());
    res = await ann.post('/api/push/subscriptions', { json: subscription(phone, '/send/ann-phone') });
    assert.equal(res.status, 200, 'saving the same subscription again is fine');
    assert.equal((await ann.request('/api/push/subscriptions', { method: 'DELETE', json: { endpoint: 'https://push.example.net/x' } })).status, 200);

    res = await bob.request('/api/push/subscriptions', { method: 'DELETE', json: { endpoint: `${service.origin}/send/ann-phone` } });
    assert.deepEqual(await res.json(), { removed: 0 }, "bob cannot remove ann's");
    assert.equal((await rows()).length, 1);
  });

  test('a test notification arrives: addressed to the service, signed for it, readable only with the browser key', async () => {
    const res = await ann.post('/api/push/test');
    assert.deepEqual(await res.json(), { sent: 1, gone: 0, failed: 0 });
    const got = await service.next();
    assert.equal(got.path, '/send/ann-phone');
    assert.equal(got.headers['content-encoding'], 'aes128gcm');
    assert.equal(got.headers.ttl, '86400');
    assert.equal(got.headers.urgency, 'high');
    assert.match(got.headers.authorization, new RegExp(`^vapid t=[A-Za-z0-9_.-]+, k=${pair.publicKey}$`));
    assert.throws(() => JSON.parse(got.body.toString('utf8')), 'the service sees ciphertext');
    assert.throws(() => decrypt(got.body, browserKeys()), 'another browser cannot read it');
    assert.deepEqual(read(got, phone), { title: 'Taskflow will notify you here', body: 'When a job needs you, when it finishes, and when a pull request opens.', url: '/', tag: 'test' });
  });

  test('a job that asks, and a job that ends, reach the phone with the page to open', async () => {
    const { job } = await (await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-2' } } })).json();
    const leased = await (await runner('jobs/next', { kinds: ['implement'], wait: 0 })).json();
    assert.equal(leased.job.id, job.id);
    let res = await runner(`jobs/${job.id}/questions`, { kind: 'ask', question: { text: 'Which colour for the badge?', options: ['red', 'blue'] } });
    const askedText = await res.text();
    assert.equal(res.status, 200, askedText);
    assert.equal(JSON.parse(askedText).job.requestedByLogin, 'ann');
    let got = read(await service.next(), phone);
    assert.deepEqual(got, { title: 'Implement batch-2 needs you', body: 'Which colour for the badge?', url: `/p/harbor/u/ann/#/job/${job.id}`, tag: 'batch:batch-2' });

    res = await runner(`jobs/${job.id}/questions`, { kind: 'permission', question: { tool: 'Bash', input: { command: 'git push --force' }, reason: 'needs approval' } });
    assert.equal(res.status, 200);
    got = read(await service.next(), phone);
    assert.equal(got.title, 'Implement batch-2 needs you');
    assert.match(got.body, /^Allow Bash\? .*git push --force/);

    res = await runner(`jobs/${job.id}/state`, { state: 'done', result: { type: 'result', subtype: 'success', is_error: false, num_turns: 9, duration_ms: 1000, total_cost_usd: 0.5, result: '\nBatch complete: batch 2\n\nPR: https://github.com/harbor/books/pull/7\n' } });
    assert.equal(res.status, 200, await res.text());
    got = read(await service.next(), phone);
    assert.deepEqual(got, { title: 'Implement batch-2 finished', body: 'Batch complete: batch 2', url: `/p/harbor/u/ann/#/job/${job.id}`, tag: 'batch:batch-2' });

    const failed = (await (await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-3' } } })).json()).job;
    await runner('jobs/next', { kinds: ['implement'], wait: 0 });
    await runner(`jobs/${failed.id}/state`, { state: 'failed', error: 'the build broke twice\nmore detail' });
    got = read(await service.next(), phone);
    assert.deepEqual([got.title, got.body, got.tag], ['Implement batch-3 failed', 'the build broke twice', 'batch:batch-3']);
    assert.equal(service.delivered.length, 5, 'nothing else was sent');
  });

  test("a cycle push that brings a pull request's url tells the developer, once", async () => {
    const trip = await roundTrip(specs['kitchen-sink']);
    try {
      const wire = trip.wire;
      let res = await ann.request(api('sync/cycle'), { method: 'PUT', json: wire });
      const firstText = await res.text();
      assert.equal(res.status, 200, firstText);
      assert.deepEqual(JSON.parse(firstText).prOpened, [], 'the first push of a cycle is history, not news');
      wire.batchFiles['batch-3'].data = { ...wire.batchFiles['batch-3'].data, status: 'pr-created', pr_url: 'https://github.com/harbor/books/pull/9' };
      res = await ann.request(api('sync/cycle'), { method: 'PUT', json: wire });
      assert.deepEqual((await res.json()).prOpened, [{ batchKey: 'batch-3', prUrl: 'https://github.com/harbor/books/pull/9' }]);
      const got = read(await service.next(), phone);
      assert.deepEqual(got, { title: 'Pull request opened for batch-3', body: 'https://github.com/harbor/books/pull/9', url: '/p/harbor/u/ann/#/batch/batch-3', tag: 'batch:batch-3' });
      res = await ann.request(api('sync/cycle'), { method: 'PUT', json: wire });
      assert.deepEqual((await res.json()).prOpened, [], 'the same url again is not news');
    } finally {
      await rm(trip.dir, { recursive: true, force: true });
    }
  });

  test('a machine that ran into its usage window says so, with when it resumes', async () => {
    const until = new Date(Date.UTC(2026, 9, 9, 15, 30)).toISOString();
    const res = await runner(`machines/${machine}/usage`, { usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: 1_790_000_000 }] }, pausedUntil: until });
    assert.equal(res.status, 200, await res.text());
    const got = read(await service.next(), phone);
    assert.deepEqual(got, { title: 'laptop is paused', body: 'The usage window is used up. Jobs resume at 15:30 UTC.', url: '/p/harbor/u/ann/#/jobs', tag: `machine:${machine}` });
    await runner(`machines/${machine}/usage`, { usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: 1_790_000_000 }] } });
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(service.delivered.length, 7, 'a reading without a pause sends nothing');
  });

  test('an endpoint the service says is gone is forgotten; the others still get the news', async () => {
    const tablet = browserKeys();
    assert.equal((await ann.post('/api/push/subscriptions', { json: subscription(tablet, '/gone/ann-tablet') })).status, 200);
    assert.equal((await rows()).length, 2);
    const res = await ann.post('/api/push/test');
    assert.deepEqual(await res.json(), { sent: 1, gone: 1, failed: 0 });
    assert.equal(service.gone, 1);
    assert.deepEqual((await rows()).map((r) => r.endpoint), [`${service.origin}/send/ann-phone`]);
    await service.next();
  });
});
