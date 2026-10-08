// Sign-in, sessions, tokens and who may see what, against a stand-in GitHub.

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { specs } from '../../test/fixtures/specs.mjs';
import { roundTrip } from '../../test/helpers/trip.mjs';
import { readConfig } from '../config.mjs';
import { profile, startHosted } from './helpers/hosted.mjs';
import { push } from './helpers/push.mjs';

const SECRET_TEXT = /Shelf: crop|Ask Mara|Loyalty points|packing slip|sold-out/i; // ticket text of the fixture: must never reach someone it is not for

/** A project with a pushed cycle, owned by whoever `owner` signs in as. */
async function withProject(h, browser, { key, owner }) {
  const made = await browser.post('/settings/projects', { form: { id: key, name: `Project ${key}` } });
  assert.equal(made.status, 200, `project ${key} created`);
  const user = (await h.db.query('select id from app_user where lower(login) = lower($1)', [owner])).rows[0];
  const trip = await roundTrip(specs.questions, { cycleId: crypto.randomUUID() });
  await push(h.db, { projectId: key, userId: user.id, payload: trip.wire, blobs: trip.blobs });
  await rm(trip.dir, { recursive: true, force: true });
}

describe('signing in', () => {
  let h;
  before(async () => { h = await startHosted({ admins: ['ann'] }); });
  after(() => h.close());

  test('signed out: a sign-in page, a way back to where you were going, and no data anywhere', async () => {
    const b = h.browser();
    const home = await b.get('/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Sign in with GitHub/);
    assert.match(home.headers.get('content-security-policy'), /default-src 'none'.*form-action 'self'/);

    const page = await b.get('/p/demo/u/sam/', { follow: false });
    assert.deepEqual([page.status, page.headers.get('location')], [302, '/?next=%2Fp%2Fdemo%2Fu%2Fsam%2F']);
    for (const path of ['/p/demo/u/sam/api/model', '/p/demo/u/sam/api/task/qs101', '/p/demo/u/sam/api/events', '/p/demo/u/sam/attachments/qs101/a.png', '/p/demo/u/sam/app.js', '/api/me']) {
      const res = await b.get(path, { follow: false });
      assert.equal(res.status, 401, path);
      assert.doesNotMatch(await res.text(), SECRET_TEXT);
    }
    assert.equal((await b.get('/settings', { follow: false })).status, 302);
    assert.equal((await b.post('/settings/tokens', { form: { label: 'x' } })).status, 401);
  });

  test('a configured admin gets in: no scope asked, PKCE checked, a session cookie that script cannot read', async () => {
    const b = h.browser();
    const res = await b.signIn(profile('Ann'));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Projects/);

    const asked = h.github.seen.authorize.at(-1);
    assert.equal(asked.scope, undefined, 'no scope at all');
    assert.deepEqual([asked.code_challenge_method, asked.allow_signup, asked.code_challenge.length], ['S256', 'false', 43]);
    const cookie = b.jar.get('tf_session').attrs;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=2592000/);
    assert.ok(!b.jar.has('tf_oauth'), 'the round-trip cookie is gone');

    const row = (await h.db.query("select login, is_instance_admin, github_id from app_user where lower(login) = 'ann'")).rows[0];
    assert.deepEqual([row.login, row.is_instance_admin, row.github_id !== null], ['Ann', true, true]);
    const stored = (await h.db.query('select id_hash from session')).rows[0].id_hash;
    assert.notEqual(stored, b.jar.get('tf_session').value, 'only a hash is kept');
  });

  test('a stranger is told so, and leaves nothing behind', async () => {
    const b = h.browser();
    const res = await b.signIn(profile('mallory'));
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Not invited/);
    assert.ok(!b.jar.has('tf_session'));
    assert.equal((await h.db.query("select count(*)::int as n from app_user where lower(login) = 'mallory'")).rows[0].n, 0);
    assert.equal((await h.db.query("select count(*)::int as n from audit_log where action = 'signin.refused'")).rows[0].n, 1);
  });

  test('a callback that was not started here, or whose state was swapped, is refused', async () => {
    const b = h.browser();
    assert.equal((await b.get('/auth/callback?code=abc&state=xyz')).status, 400);

    h.github.as(profile('Ann'));
    const toGithub = await b.get('/auth/github', { follow: false });
    const back = await fetch(toGithub.headers.get('location'), { redirect: 'manual' });
    const tampered = new URL(back.headers.get('location'));
    tampered.searchParams.set('state', 'someone-elses-state');
    assert.equal((await b.get(tampered.pathname + tampered.search)).status, 400);
    assert.ok(!b.jar.has('tf_session'));
  });

  test('the way back after sign-in is only ever a page of this site', async () => {
    const b = h.browser();
    await b.signIn(profile('Ann'), { next: 'https://evil.example.com/' });
    assert.equal(b.hops.at(-1), '200 /');
    const c = h.browser();
    await c.signIn(profile('Ann'), { next: '/settings' });
    assert.equal(c.hops.at(-1), '200 /settings');
  });

  test('signing out needs our own origin, ends the session on the server, and clears the cookie', async () => {
    const b = h.browser();
    await b.signIn(profile('Ann'));
    assert.equal((await b.post('/auth/logout', { origin: false, follow: false })).status, 403);
    assert.equal((await b.get('/api/me')).status, 200);

    const kept = b.jar.get('tf_session').value;
    await b.post('/auth/logout');
    assert.ok(!b.jar.has('tf_session'));
    const replay = await fetch(`${h.origin}/api/me`, { headers: { Cookie: `tf_session=${kept}` } });
    assert.equal(replay.status, 401, 'a copied cookie is worthless after sign-out');
  });

  test('a session in use keeps its thirty days; an expired one is nobody', async () => {
    const b = h.browser();
    await b.signIn(profile('Ann'));
    await h.db.query("update session set last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 day'");
    const res = await b.get('/api/me');
    assert.equal(res.status, 200);
    assert.match(res.headers.getSetCookie().join(';'), /tf_session=.*Max-Age=2592000/);
    assert.equal((await h.db.query("select count(*)::int as n from session where expires_at > now() + interval '29 days'")).rows[0].n >= 1, true);

    await h.db.query("update session set expires_at = now() - interval '1 minute'");
    assert.equal((await b.get('/api/me')).status, 401);
  });
});

describe('who sees what', () => {
  let h;
  let ann; // instance admin, owns a cycle in alpha
  let bob; // developer in alpha, invited
  let cat; // admin of beta, a separate project
  let ivy; // answerer in alpha

  before(async () => {
    h = await startHosted({ admins: ['ann', 'cat'] });
    ann = h.browser(); await ann.signIn(profile('ann'));
    cat = h.browser(); await cat.signIn(profile('cat'));
    await withProject(h, ann, { key: 'alpha', owner: 'ann' });
    await withProject(h, cat, { key: 'beta', owner: 'cat' });

    await ann.post('/settings/members/invite', { form: { project: 'alpha', login: '@Bob', role: 'developer' } });
    await ann.post('/settings/members/invite', { form: { project: 'alpha', login: 'ivy', role: 'answerer' } });
    bob = h.browser(); await bob.signIn(profile('bob'));
    ivy = h.browser(); await ivy.signIn(profile('ivy'));
  });
  after(() => h.close());

  test('an invite by login is consumed at first sign-in, and only once', async () => {
    const members = await h.db.query("select u.login, m.role from membership m join app_user u on u.id = m.user_id where m.project_id = 'alpha' order by 1");
    assert.deepEqual(members.rows, [{ login: 'ann', role: 'admin' }, { login: 'bob', role: 'developer' }, { login: 'ivy', role: 'answerer' }]);
    assert.equal((await h.db.query('select count(*)::int as n from invite')).rows[0].n, 0);
    assert.match(await (await bob.get('/')).text(), /ann&#39;s cycle/);
  });

  test('a member of one project gets, from every route of another, exactly what an unknown project gives', async () => {
    const routes = ['', 'api/model', 'api/task/qs101', 'api/summary', 'api/cycles', 'api/events', 'api/me', 'attachments/qs101/a.png', 'app.js', 'api/status'];
    for (const route of routes) {
      const theirs = await bob.get(`/p/beta/u/cat/${route}`);
      const nowhere = await bob.get(`/p/no-such/u/cat/${route}`);
      assert.deepEqual([theirs.status, await theirs.text()], [404, await nowhere.text()], route);
    }
    for (const route of ['api/answer', 'api/inbox', 'api/answer/confirm']) {
      const res = await bob.post(`/p/beta/u/cat/${route}`, { json: { id: 'question:qs101:q-cover-ratio' } });
      assert.equal(res.status, 404, route);
    }
    assert.equal((await bob.post('/settings/members/invite', { form: { project: 'beta', login: 'bob', role: 'admin' } })).status, 404, 'nor invite themselves in');
    assert.doesNotMatch(await (await bob.get('/')).text(), /beta/i);
  });

  test('being an instance admin opens no project they were not added to', async () => {
    assert.equal((await ann.get('/p/beta/u/cat/api/model')).status, 404);
  });

  test('an answerer is a member with nothing to look at yet: refused, not hidden from', async () => {
    const page = await ivy.get('/p/alpha/u/ann/');
    assert.equal(page.status, 403);
    assert.doesNotMatch(await page.text(), SECRET_TEXT);
    assert.equal((await ivy.get('/p/alpha/u/ann/api/model')).status, 403);
    assert.equal((await ivy.post('/settings/tokens', { form: { label: 'x' } })).status, 403, 'and holds no CLI token');
  });

  test('you write on your own cycle; a teammate\'s is read-only, and the page is told so', async () => {
    const model = await (await ann.get('/p/alpha/u/ann/api/model')).json();
    const item = model.inbox['question:qs101:q-cover-ratio'];
    assert.equal(model.cycle.readOnly, false);

    assert.deepEqual(await (await bob.get('/p/alpha/u/ann/api/me')).json(), { signedIn: true, login: 'bob', role: 'developer', owner: 'ann', ownsCycle: false, canWrite: false, push: { available: false, publicKey: null } });
    assert.equal((await bob.post('/p/alpha/u/ann/api/answer', { json: { id: item.id, fingerprint: item.fingerprint, body: 'Square.' } })).status, 403);

    assert.equal((await (await ann.get('/p/alpha/u/ann/api/me')).json()).canWrite, true);
    assert.equal((await ann.post('/p/alpha/u/ann/api/answer', { json: { id: item.id, fingerprint: item.fingerprint, body: 'Square.' }, origin: false })).status, 403, 'a write must state its origin');
    const saved = await ann.post('/p/alpha/u/ann/api/answer', { json: { id: item.id, fingerprint: item.fingerprint, body: 'Square.' } });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).item.state, 'handled');
    assert.equal((await (await bob.get('/p/alpha/u/ann/api/model')).json()).inbox[item.id].answer.body, 'Square.', 'the teammate sees it');
  });

  test('a browser that withholds Origin still proves where a form came from; nothing else does', async () => {
    const form = { form: { label: 'fetch-metadata' }, origin: false };
    assert.equal((await ann.post('/settings/tokens', { ...form, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200, 'no Origin, same-origin by the browser\'s word');
    assert.equal((await ann.post('/settings/tokens', { ...form, headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' } })).status, 200, 'Origin: null, as Chromium sends under no-referrer');
    assert.equal((await ann.post('/settings/tokens', { ...form, headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await ann.post('/settings/tokens', { ...form, headers: { Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'same-origin' } })).status, 403, 'a stated foreign Origin is never overruled');
    assert.equal((await ann.post('/settings/tokens', { ...form, headers: { Origin: 'null' } })).status, 403);
  });

  test('settings forms take our own origin only', async () => {
    assert.equal((await ann.post('/settings/tokens', { form: { label: 'x' }, origin: false })).status, 403);
    assert.equal((await ann.post('/settings/tokens', { form: { label: 'x' }, headers: { Origin: 'https://evil.example.com' }, origin: false })).status, 403);
    assert.equal((await ann.post('/settings/tokens', { json: { label: 'x' } })).status, 415);
  });

  test('only a project admin manages members; a project always keeps one', async () => {
    assert.equal((await bob.post('/settings/members/invite', { form: { project: 'alpha', login: 'dan', role: 'developer' } })).status, 403);
    const annId = (await h.db.query("select id from app_user where login = 'ann'")).rows[0].id;
    const demote = await ann.post('/settings/members/role', { form: { project: 'alpha', user: annId, role: 'developer' } });
    assert.equal(demote.status, 409);
    assert.match(await demote.text(), /at least one admin/);
    assert.equal((await ann.post('/settings/projects', { form: { id: 'Bad Key!', name: 'x' } })).status, 400);
    assert.equal((await bob.post('/settings/projects', { form: { id: 'mine', name: 'x' } })).status, 403);
  });

  test('what people type comes back as text, never as markup', async () => {
    await ann.post('/settings/projects', { form: { id: 'gamma', name: '<script>alert(1)</script>' } });
    const page = await (await ann.get('/settings')).text();
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!page.includes('<script>alert'));
  });

  test('leaving your last project ends your sessions and tokens', async () => {
    const dan = h.browser();
    await ann.post('/settings/members/invite', { form: { project: 'alpha', login: 'dan', role: 'developer' } });
    await dan.signIn(profile('dan'));
    const made = await (await dan.post('/settings/tokens', { form: { label: 'laptop' } })).text();
    const token = /tfp_[A-Za-z0-9_-]+/.exec(made)[0];
    assert.equal((await fetch(`${h.origin}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);

    const danId = (await h.db.query("select id from app_user where login = 'dan'")).rows[0].id;
    await ann.post('/settings/members/remove', { form: { project: 'alpha', user: danId } });
    assert.equal((await dan.get('/api/me')).status, 401);
    assert.equal((await fetch(`${h.origin}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  });
});

describe('CLI tokens', () => {
  let h;
  let ann;
  let token;
  before(async () => {
    h = await startHosted({ admins: ['ann'] });
    ann = h.browser(); await ann.signIn(profile('ann'));
    await withProject(h, ann, { key: 'alpha', owner: 'ann' });
    token = /tfp_[A-Za-z0-9_-]+/.exec(await (await ann.post('/settings/tokens', { form: { label: 'laptop' } })).text())[0];
  });
  after(() => h.close());
  const bearer = (path, value = token, init = {}) => fetch(`${h.origin}${path}`, { ...init, headers: { Authorization: `Bearer ${value}`, ...(init.headers ?? {}) } });

  test('shown once, kept as a hash, and listed afterwards by name only', async () => {
    const stored = (await h.db.query('select token_hash, label from api_token')).rows[0];
    assert.deepEqual([stored.label, stored.token_hash.length, stored.token_hash.includes(token.slice(4))], ['laptop', 64, false]);
    const page = await (await ann.get('/settings')).text();
    assert.match(page, /laptop/);
    assert.ok(!page.includes(token));
  });

  test('it is that person, for reading; it cannot answer, and it cannot reach settings', async () => {
    assert.deepEqual(await (await bearer('/api/me')).json().then((me) => [me.login, me.via, me.projects.map((p) => p.id)]), ['ann', 'token', ['alpha']]);
    assert.equal((await bearer('/p/alpha/u/ann/api/model')).status, 200);
    const item = (await (await bearer('/p/alpha/u/ann/api/model')).json()).inbox['question:qs101:q-cover-ratio'];
    const write = await bearer('/p/alpha/u/ann/api/answer', token, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.origin }, body: JSON.stringify({ id: item.id, fingerprint: item.fingerprint, body: 'x' }) });
    assert.equal(write.status, 403);
    assert.equal((await bearer('/settings', token, { redirect: 'manual' })).status, 302);
    assert.equal((await bearer('/settings/tokens', token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: h.origin }, body: 'label=more' })).status, 401);
  });

  test('revoked, malformed or made up: 401, and an address that keeps guessing is slowed down', async () => {
    const second = /tfp_[A-Za-z0-9_-]+/.exec(await (await ann.post('/settings/tokens', { form: { label: 'old' } })).text())[0];
    const id = (await h.db.query("select id from api_token where label = 'old'")).rows[0].id;
    await ann.post('/settings/tokens/revoke', { form: { id } });
    assert.equal((await bearer('/api/me', second)).status, 401);
    assert.equal((await fetch(`${h.origin}/api/me`, { headers: { Authorization: 'Basic abc' } })).status, 401);

    let last = 0;
    for (let i = 0; i < 25; i++) last = (await bearer('/api/me', `tfp_${'x'.repeat(40)}${i}`)).status;
    assert.equal(last, 429);
    assert.equal((await bearer('/api/me')).status, 429, 'the address is slowed down, good token or not');
  });
});

describe('what the server will start on, with sign-in', () => {
  const base = { DATABASE_URL: 'postgres://x/y', GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 'secret', SESSION_SECRET: 's'.repeat(32), ADMIN_GITHUB_LOGINS: 'Ann, bob' };

  test('a public https origin, bound to every interface on the port the host gives', () => {
    const config = readConfig({ ...base, PUBLIC_URL: 'https://flow.example.com', PORT: '8080' });
    assert.deepEqual(config.bind, { host: '0.0.0.0', port: 8080 });
    assert.deepEqual([config.auth.admins, config.auth.secureCookies], [['ann', 'bob'], true]);
    assert.deepEqual(readConfig({ ...base, PUBLIC_URL: 'http://127.0.0.1:3900' }).bind, { host: '127.0.0.1', port: 3900 }, 'sign-in on loopback, for development');
  });

  test('half a configuration, a short secret, plain http in public, no port: all refused', () => {
    const refused = (env, pattern) => assert.throws(() => readConfig(env), (e) => e.config === true && pattern.test(e.message));
    refused({ ...base, PUBLIC_URL: 'https://flow.example.com', PORT: '8080', SESSION_SECRET: undefined }, /half configured.*SESSION_SECRET/);
    refused({ ...base, PUBLIC_URL: 'https://flow.example.com', PORT: '8080', SESSION_SECRET: 'short' }, /too short/);
    refused({ ...base, PUBLIC_URL: 'http://flow.example.com', PORT: '8080' }, /must be https/);
    refused({ ...base, PUBLIC_URL: 'https://flow.example.com' }, /PORT is not set/);
    refused({ ...base, PUBLIC_URL: 'https://flow.example.com', PORT: '8080', ADMIN_GITHUB_LOGINS: 'not a login!' }, /GitHub logins/);
  });
});

test('the deploy check may ask for health under its own name, and for nothing else', async () => {
  const h = await startHosted();
  try {
    const { request } = await import('node:http');
    const raw = (path, host) => new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port: h.port, path, headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); });
    assert.equal(await raw('/api/health', 'healthcheck.railway.app'), 200);
    assert.equal(await raw('/', 'healthcheck.railway.app'), 403);
    assert.equal(await raw('/api/me', 'healthcheck.railway.app'), 403);
  } finally {
    await h.close();
  }
});
