// The hosted dashboard: many projects, each developer's cycles under their own path.
//
//   /api/health                      name and version, nothing else
//   /                                sign in, or the list of your projects
//   /auth/github, /auth/callback     GitHub sign-in;  POST /auth/logout
//   /settings                        your CLI tokens; members and projects, if you manage any
//   /api/me                          who a session or a token belongs to
//   /api/p/<project>/jobs, /machines  the job queue: the page asks, a runner on the asker's machine answers
//   /p/<project>/u/<login>/...       the report (scripts/report/handler.mjs), mounted
//
// The page's URLs are all relative, so the unchanged client works under that
// prefix. Tenancy is in the path and nowhere else: a request is resolved to one
// project and one owner, the asker's role IN THAT PROJECT is looked up, and the
// handler it reaches was built over a backend that can address only those two.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, baseHeaders, createReportHandler, sendError, sendJson } from '../scripts/report/handler.mjs';
import { createAccounts } from './accounts.mjs';
import { createAuth, createRateLimiter, safeNext } from './auth.mjs';
import { ACTIONS, createAuthorizer } from './authorize.mjs';
import { createPgBackend } from './backend-pg.mjs';
import { MAX_BLOB_BYTES, MAX_PAYLOAD_BYTES } from '../scripts/report/payload.mjs';
import { importLocalHumanState } from './import-local.mjs';
import { ingestCycle, putBlob } from './ingest.mjs';
import { archiveCycle, claimBatch, cycleState, releaseBatch } from './sync.mjs';
import { answerQuestion, appendEvents, askQuestion, awaitAnswer, cancelJob, getJob, leaseJobWait, listJobs, listMachines, parkQuestion, registerMachine, reportJob, reportUsage, requestJob } from './jobs.mjs';
import { ACCOUNT_CSP, homePage, messagePage, notInvitedPage, settingsPage, signInPage } from './pages.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(HERE, '..', 'scripts', 'report', 'ui', 'fonts');
const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{1,38}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const MOUNT = /^\/p\/([^/]+)\/u\/([^/]+)(\/.*)?$/;
const FONT = /^\/assets\/fonts\/([a-z0-9-]+\.woff2)$/;
const SYNC = /^\/api\/p\/([^/]+)\/(sync\/cycle|sync\/blob\/[0-9a-f]{64}|claim|release|archive|import|state)$/;
const JOBS = /^\/api\/p\/([^/]+)\/(jobs|machines)((?:\/[A-Za-z0-9-]+)*)$/;
const IDLE_MS = 10 * 60 * 1000;
const MAX_FORM_BYTES = 8 * 1024;
const HEALTHCHECK_HOST = 'healthcheck.railway.app'; // Railway's deploy check arrives under this name

// One answer for "no such project", "no such developer in it" and "not yours to see": which of them it is stays private.
const notFound = () => new HttpError(404, 'Not found.');

/**
 * @param {object} options
 * @param {object} options.db
 * @param {URL|string} options.publicUrl  the origin people open; Host and Origin are checked against it
 * @param {object|null} [options.auth]    from config.mjs; null means no sign-in exists (loopback, read-only)
 * @param {object} [options.github]       OAuth endpoints, for tests
 * @param {Function} [options.resolveActor]  without sign-in only: a test's stand-in for it
 * @param {boolean} [options.readOnly]    without sign-in only: tell the page to hide its write controls
 */
export function createHostedApp({ db, publicUrl, version = 'dev', auth: authConfig = null, github, trustProxy = false, resolveActor = async () => null, readOnly = true }) {
  const home = new URL(publicUrl);
  const allowedHost = home.host.toLowerCase();
  const signInRequired = Boolean(authConfig);
  const authorize = createAuthorizer({ signInRequired });
  const accounts = createAccounts(db, { admins: authConfig?.admins ?? [] });
  const auth = signInRequired ? createAuth({ db, accounts, publicUrl: home, config: authConfig, ...(github ? { github } : {}) }) : null;
  const signInFailures = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
  const badTokens = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
  const mounted = new Map(); // "<project>:<owner id>" -> { ready, usedAt }

  function handlerFor(projectId, ownerId) {
    const key = `${projectId}:${ownerId}`;
    if (!mounted.has(key)) {
      mounted.set(key, {
        usedAt: Date.now(),
        ready: createReportHandler({
          // With sign-in, whether someone may write is a fact about them (api/me), not about the cycle.
          backend: createPgBackend(db, { projectId, ownerId, readOnly: signInRequired ? false : readOnly }),
          // Cookies ride on these writes, so the page's own origin is the only one accepted, and it must be stated.
          security: { originAllowed: (_origin, req) => fromOurPages(req) },
          canWrite: (actor) => authorize(actor, ACTIONS.WRITE_HUMAN, { ownsCycle: String(actor?.id) === String(ownerId) }),
        }),
      });
    }
    const slot = mounted.get(key);
    slot.usedAt = Date.now();
    return slot.ready;
  }

  const sweeper = setInterval(async () => {
    for (const [key, slot] of mounted) {
      const handler = await slot.ready.catch(() => null);
      if (handler && (handler.clientCount() > 0 || Date.now() - slot.usedAt < IDLE_MS)) continue;
      mounted.delete(key);
      handler?.close();
    }
  }, 60 * 1000);
  sweeper.unref();

  // -- small helpers ------------------------------------------------------------------

  /**
   * CSRF: cookies ride on every write, so a write must come from a page of ours. Its Origin says so.
   * A browser withholds Origin ("null") from a same-origin form post when the page's referrer policy is
   * no-referrer; it then still sends Sec-Fetch-Site, which page script cannot set or forge.
   */
  function fromOurPages(req) {
    const origin = req.headers.origin;
    if (origin === home.origin) return true;
    return (origin === undefined || origin === 'null') && req.headers['sec-fetch-site'] === 'same-origin';
  }

  const clientAddress = (req) => (trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',').at(-1).trim() : req.socket.remoteAddress ?? 'unknown');

  function sendPage(res, status, page) {
    // same-origin, not no-referrer: these pages post forms, and a browser only states their Origin under this policy.
    res.writeHead(status, baseHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': ACCOUNT_CSP, 'Referrer-Policy': 'same-origin' }));
    res.end(page);
  }
  function redirect(res, status, location) {
    res.writeHead(status, baseHeaders({ Location: location }));
    res.end();
  }

  /** A form post from one of our own pages, and nowhere else. */
  async function readForm(req) {
    if (!fromOurPages(req)) throw new HttpError(403, 'Cross-origin requests are not allowed.');
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send a form.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) throw new HttpError(413, 'Request body too large.');
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  async function settingsView(actor, extra = {}) {
    const projects = await accounts.projectsFor(actor);
    const managed = [];
    for (const project of projects) {
      if (authorize({ ...actor, role: project.role }, ACTIONS.MANAGE_MEMBERS)) managed.push({ id: project.id, name: project.name, ...(await accounts.members(project.id)) });
    }
    const developerSomewhere = projects.some((p) => p.role === 'admin' || p.role === 'developer');
    const canHoldTokens = authorize(actor, ACTIONS.MANAGE_TOKENS, { developerSomewhere });
    return settingsPage({
      user: actor, managed, canHoldTokens, serverUrl: home.origin,
      tokens: canHoldTokens ? await accounts.tokens(actor) : [],
      canCreateProject: authorize(actor, ACTIONS.CREATE_PROJECT),
      ...extra,
    });
  }

  // -- what the CLI talks to ---------------------------------------------------------------

  async function readBytes(req, max) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw new HttpError(413, `Too large: ${max} bytes at most.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function readJson(req, max) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send application/json.');
    try {
      return JSON.parse((await readBytes(req, max)).toString('utf8'));
    } catch (error) {
      throw error.status ? error : new HttpError(400, 'Body is not valid JSON.');
    }
  }

  /** /api/p/<project>/...: push, claim, release, state. Always about the asker's OWN cycle in that project. */
  async function syncRoutes(req, res, match, actor) {
    const [, projectKey, what] = match;
    if (!actor) throw new HttpError(401, 'Sign in, or send a token.');
    if (!PROJECT_KEY.test(projectKey)) throw notFound();
    const role = await accounts.roleIn(projectKey, actor.id);
    if (!role) throw notFound();
    if (!authorize({ ...actor, role }, ACTIONS.SYNC_CYCLE)) throw new HttpError(403, 'Only a developer of this project has a cycle to push or claim from.');
    // A token carries no ambient authority. A session cookie does, so a browser must show where it is calling from.
    if (actor.via === 'session' && req.method !== 'GET' && !fromOurPages(req)) throw new HttpError(403, 'Cross-origin requests are not allowed.');
    const who = { projectId: projectKey, userId: actor.id };

    if (what === 'state' && req.method === 'GET') return sendJson(res, 200, await cycleState(db, who));
    if (what === 'sync/cycle' && req.method === 'PUT') {
      const result = await ingestCycle(db, { ...who, payload: await readJson(req, MAX_PAYLOAD_BYTES + 1024) });
      await notify(projectKey);
      return sendJson(res, 200, result);
    }
    if (what.startsWith('sync/blob/') && req.method === 'PUT') {
      const result = await putBlob(db, { projectId: projectKey, sha256: what.slice('sync/blob/'.length), body: await readBytes(req, MAX_BLOB_BYTES) });
      await notify(projectKey);
      return sendJson(res, 200, result);
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const body = await readJson(req, 1024 * 1024);
    let result;
    if (what === 'claim') result = await claimBatch(db, { ...who, batchKey: body.batchKey ?? null, stack: body.stack === true, resume: body.resume === true, host: body.host ?? null });
    else if (what === 'release') result = await releaseBatch(db, { ...who, batchKey: body.batchKey });
    else if (what === 'archive') result = await archiveCycle(db, { ...who, cycleId: body.cycleId });
    else if (what === 'import') {
      const live = (await db.query('select id from cycle where project_id = $1 and user_id = $2 and is_live', [projectKey, actor.id])).rows[0];
      if (!live) throw new HttpError(409, 'Push the cycle first.');
      result = await importLocalHumanState(db, { ...who, cycleUuid: live.id, answersJson: body.answers ?? null, ticksJson: body.ticks ?? null });
    } else throw notFound();
    await notify(projectKey);
    return sendJson(res, 200, result);
  }

  /**
   * /api/p/<project>/jobs… and /machines: the queue. A page (session) requests, cancels and answers;
   * a runner (token) registers its machine, leases, reports, forwards events and asks. Both are
   * developers of the project, and a job is always the requesting developer's own.
   */
  async function jobRoutes(req, res, match, actor, url) {
    const [, projectKey, head, tail] = match;
    if (!actor) throw new HttpError(401, 'Sign in, or send a token.');
    if (!PROJECT_KEY.test(projectKey)) throw notFound();
    const role = await accounts.roleIn(projectKey, actor.id);
    if (!role) throw notFound();
    const who = { ...actor, role };
    const parts = tail ? tail.slice(1).split('/') : [];
    const who2 = { projectId: projectKey, userId: actor.id };
    const asPage = () => {
      if (!authorize(who, ACTIONS.REQUEST_JOB)) throw new HttpError(403, 'Only a developer of this project, in the browser, can do that.');
      if (req.method !== 'GET' && !fromOurPages(req)) throw new HttpError(403, 'Cross-origin requests are not allowed.');
    };
    const asRunner = () => { if (!authorize(who, ACTIONS.RUN_JOBS)) throw new HttpError(403, 'Only a runner holding a developer token can do that.'); };
    const asDeveloper = () => { if (!authorize(who, ACTIONS.SYNC_CYCLE)) throw new HttpError(403, 'Only a developer of this project can see jobs.'); };
    const body = async () => readJson(req, 2 * 1024 * 1024);
    const done = async (result) => { await notifyJobs(projectKey, result?.rev ?? null); return sendJson(res, 200, result); };

    if (head === 'machines') {
      if (parts.length === 0 && req.method === 'GET') { asDeveloper(); return sendJson(res, 200, { machines: await listMachines(db, who2) }); }
      if (parts.length === 0 && req.method === 'POST') { asRunner(); const b = await body(); return sendJson(res, 200, { machine: await registerMachine(db, { userId: actor.id, id: b.id ?? null, name: b.name, kinds: b.kinds, concurrency: b.concurrency, runnerVersion: b.runnerVersion }) }); }
      if (parts.length === 2 && parts[1] === 'usage' && req.method === 'POST') { asRunner(); const b = await body(); return done({ machine: await reportUsage(db, { userId: actor.id, machineId: parts[0], usage: b.usage ?? null, pausedUntil: b.pausedUntil ?? null }) }); }
      throw notFound();
    }

    if (parts.length === 0) {
      if (req.method === 'GET') { asDeveloper(); return sendJson(res, 200, await listJobs(db, { ...who2, limit: url.searchParams.get('limit') })); }
      if (req.method === 'POST') { asPage(); const b = await body(); return done(await requestJob(db, { ...who2, kind: b.kind, args: b.args, machineId: b.machineId ?? null })); }
      throw new HttpError(405, 'Method not allowed.');
    }
    if (parts[0] === 'next') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      asRunner();
      const b = await body();
      const leased = await leaseJobWait(db, { ...who2, machineId: b.machineId, kinds: b.kinds }, b.wait);
      if (leased.job) await notifyJobs(projectKey, leased.rev ?? null);
      return sendJson(res, 200, leased);
    }
    const jobId = parts[0];
    if (parts.length === 1) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      asDeveloper();
      return sendJson(res, 200, await getJob(db, { ...who2, jobId, after: url.searchParams.get('after') }));
    }
    if (req.method !== 'POST' && !(parts[1] === 'questions' && parts.length === 3 && req.method === 'GET')) throw new HttpError(405, 'Method not allowed.');
    const what = parts.slice(1).join('/');
    if (what === 'cancel') { asPage(); return done(await cancelJob(db, { ...who2, jobId })); }
    if (what === 'events') { asRunner(); const b = await body(); return done(await appendEvents(db, { ...who2, jobId, machineId: b.machineId, events: b.events })); }
    if (what === 'state') { asRunner(); const b = await body(); return done(await reportJob(db, { ...who2, jobId, machineId: b.machineId, state: b.state, sessionId: b.sessionId ?? null, result: b.result ?? null, error: b.error ?? null })); }
    if (what === 'questions') { asRunner(); const b = await body(); return done(await askQuestion(db, { ...who2, jobId, machineId: b.machineId, kind: b.kind, question: b.question })); }
    if (parts[1] === 'questions' && parts.length >= 3) {
      const questionId = parts[2];
      if (parts.length === 3) { asRunner(); return sendJson(res, 200, await awaitAnswer(db, { ...who2, jobId, questionId, waitMs: url.searchParams.get('wait') })); }
      if (parts[3] === 'answer' && parts.length === 4) { asPage(); const b = await body(); return done(await answerQuestion(db, { ...who2, jobId, questionId, answer: b.answer ?? b })); }
      if (parts[3] === 'park' && parts.length === 4) { asRunner(); const b = await body(); return done(await parkQuestion(db, { ...who2, jobId, machineId: b.machineId, questionId })); }
    }
    throw notFound();
  }

  // -- routes that exist only with sign-in ------------------------------------------------

  async function accountRoutes(req, res, path, url, actor) {
    const get = req.method === 'GET' || req.method === 'HEAD';

    if (path === '/assets/account.css' && get) {
      res.writeHead(200, baseHeaders({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }));
      return res.end(await readFile(join(HERE, 'assets', 'account.css')));
    }
    const font = FONT.exec(path);
    if (font && get) {
      const body = await readFile(join(FONTS_DIR, font[1])).catch(() => null);
      if (!body) throw notFound();
      res.writeHead(200, baseHeaders({ 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=86400' }));
      return res.end(body);
    }

    if (path === '/auth/github' && get) {
      if (signInFailures.blocked(clientAddress(req))) throw new HttpError(429, 'Too many failed sign-ins from this address. Try again in a few minutes.');
      return auth.start(req, res, url);
    }
    if (path === '/auth/callback' && get) {
      const address = clientAddress(req);
      if (signInFailures.blocked(address)) throw new HttpError(429, 'Too many failed sign-ins from this address. Try again in a few minutes.');
      const result = await auth.callback(req, res, url);
      if (result.ok) return redirect(res, 303, result.next);
      signInFailures.fail(address);
      if (result.reason === 'not-invited') return sendPage(res, 403, notInvitedPage({ login: result.login }));
      return sendPage(res, result.reason === 'github' ? 502 : 400, signInPage({ notice: result.reason === 'github' ? 'GitHub did not answer as expected. Try again.' : 'That sign-in attempt had expired or was not started here. Try again.' }));
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      // A page of ours, stating so. The dashboard posts with fetch(), the account pages with a form.
      if (!fromOurPages(req)) throw new HttpError(403, 'Cross-origin requests are not allowed.');
      await auth.logout(req, res);
      return redirect(res, 303, '/');
    }

    if (path === '/' && get) {
      if (!actor) return sendPage(res, 200, signInPage({ next: safeNext(url.searchParams.get('next')) }));
      return sendPage(res, 200, homePage({ user: actor, projects: await accounts.projectsFor(actor) }));
    }
    if (path === '/api/me' && get) {
      if (!actor) throw new HttpError(401, 'Sign in.');
      return sendJson(res, 200, { login: actor.login, name: actor.name, isInstanceAdmin: actor.isInstanceAdmin, via: actor.via, projects: await accounts.projectsFor(actor) });
    }

    if (!path.startsWith('/settings')) return false;
    // Settings are for a person at a browser. A CLI token must not be able to mint more tokens or invite anyone.
    if (!actor || actor.via !== 'session') {
      if (!get) throw new HttpError(401, 'Sign in.');
      return redirect(res, 302, '/?next=/settings');
    }
    if (path === '/settings' && get) return sendPage(res, 200, await settingsView(actor));
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

    const form = await readForm(req);
    try {
      if (path === '/settings/tokens') {
        const projects = await accounts.projectsFor(actor);
        if (!authorize(actor, ACTIONS.MANAGE_TOKENS, { developerSomewhere: projects.some((p) => p.role !== 'answerer') })) throw new HttpError(403, 'Your role holds no CLI token.');
        const made = await accounts.createToken(actor, form.get('label'));
        // Rendered, never redirected to: a token must not end up in a URL or in history.
        return sendPage(res, 200, await settingsView(actor, { newToken: made.token }));
      }
      if (path === '/settings/tokens/revoke') await accounts.revokeToken(actor, form.get('id'));
      else if (path === '/settings/projects') {
        if (!authorize(actor, ACTIONS.CREATE_PROJECT)) throw new HttpError(403, 'Only an instance admin creates projects.');
        await accounts.createProject(actor, { id: form.get('id'), name: form.get('name') });
      } else {
        const projectId = form.get('project') ?? '';
        const role = PROJECT_KEY.test(projectId) ? await accounts.roleIn(projectId, actor.id) : null;
        const exists = PROJECT_KEY.test(projectId) && (role || actor.isInstanceAdmin) && (await db.query('select 1 from project where id = $1', [projectId])).rowCount > 0;
        if (!exists) throw notFound();
        if (!authorize({ ...actor, role }, ACTIONS.MANAGE_MEMBERS)) throw new HttpError(403, 'Only a project admin manages its members.');
        if (path === '/settings/members/invite') await accounts.invite(actor, projectId, { login: form.get('login'), role: form.get('role') });
        else if (path === '/settings/members/role') await accounts.setRole(actor, projectId, form.get('user'), form.get('role'));
        else if (path === '/settings/members/remove') await accounts.removeMember(actor, projectId, form.get('user'));
        else if (path === '/settings/invites/remove') await accounts.removeInvite(actor, projectId, form.get('login'));
        else throw notFound();
      }
    } catch (error) {
      // What a person typed wrong comes back on the page they typed it into.
      if (error.status === 400 || error.status === 409) return sendPage(res, error.status, await settingsView(actor, { error: error.message }));
      throw error;
    }
    return redirect(res, 303, '/settings');
  }

  // -- routing ------------------------------------------------------------------------

  async function route(req, res) {
    const url = new URL(req.url, home);
    let path;
    try {
      // Once. An encoded slash becomes a real one here and then simply fails to match.
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Malformed path.');
    }

    const host = (req.headers.host ?? '').toLowerCase();
    const health = path === '/api/health' && (req.method === 'GET' || req.method === 'HEAD');
    if (host !== allowedHost && !(health && host === HEALTHCHECK_HOST)) throw new HttpError(403, 'Unexpected Host header.');
    if (health) return sendJson(res, 200, { ok: true, name: 'taskflow', version });
    if (authConfig?.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    let actor = null;
    if (signInRequired) {
      const address = clientAddress(req);
      if (req.headers.authorization && badTokens.blocked(address)) throw new HttpError(429, 'Too many bad tokens from this address. Try again in a few minutes.');
      const resolved = await auth.resolve(req, res);
      if (resolved.badToken) { badTokens.fail(address); throw new HttpError(401, 'That token is not valid. Create a new one in Settings.'); }
      actor = resolved.actor;
      const sync = SYNC.exec(path);
      if (sync) return syncRoutes(req, res, sync, actor);
      const jobs = JOBS.exec(path);
      if (jobs) return jobRoutes(req, res, jobs, actor, url);
      const handled = await accountRoutes(req, res, path, url, actor);
      if (handled !== false) return handled;
    } else {
      const who = await resolveActor(req);
      if (who) actor = { id: String(who.id), login: who.login, isInstanceAdmin: false, via: 'session' };
    }

    const match = MOUNT.exec(path);
    if (!match || !PROJECT_KEY.test(match[1]) || !LOGIN.test(match[2])) throw notFound();
    const [, projectKey, login, rest] = match;

    if (signInRequired && !actor) {
      // The page itself sends a person to sign in and back; everything else just says so.
      if ((rest === '/' || !rest) && req.method === 'GET') return redirect(res, 302, `/?next=${encodeURIComponent(`/p/${projectKey}/u/${login}/`)}`);
      throw new HttpError(401, 'Sign in.');
    }

    if (actor) actor = { ...actor, role: await accounts.roleIn(projectKey, actor.id) };
    // No role here: the project does not exist, as far as this person is concerned.
    if (signInRequired && !actor.role) throw notFound();

    const owner = (await db.query(
      `select u.id, u.login from app_user u join membership m on m.user_id = u.id
       where m.project_id = $1 and lower(u.login) = lower($2) and m.role in ('admin', 'developer')`,
      [projectKey, login],
    )).rows[0];
    if (!owner) throw notFound();
    if (!authorize(actor, ACTIONS.READ)) {
      const message = 'Your role in this project is to answer questions. That view is not built yet.';
      if (rest === '/' && req.method === 'GET') return sendPage(res, 403, messagePage({ title: 'Nothing to show yet', message, user: actor }));
      throw new HttpError(403, message);
    }

    if (!rest) {
      // Relative URLs resolve against the last slash. Built from the checked parts, never from what was sent.
      return redirect(res, 308, `/p/${projectKey}/u/${owner.login}/`);
    }
    const ownsCycle = String(actor?.id) === String(owner.id);
    if (rest === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, {
        signedIn: signInRequired,
        login: actor?.login ?? null,
        role: actor?.role ?? null,
        owner: owner.login,
        ownsCycle,
        canWrite: authorize(actor, ACTIONS.WRITE_HUMAN, { ownsCycle }),
      });
    }
    const handler = await handlerFor(projectKey, owner.id);
    return handler.handle(req, res, { path: rest, url, actor });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => sendError(res, error));
  });

  /** A write made in this process: tell the open pages without waiting for the poll. */
  async function notify(projectId) {
    for (const [key, slot] of mounted) if (key.startsWith(`${projectId}:`)) (await slot.ready).notify();
  }
  /** A job changed: the pages of that project fetch the queue again. The model itself did not change. */
  async function notifyJobs(projectId, rev) {
    for (const [key, slot] of mounted) if (key.startsWith(`${projectId}:`)) (await slot.ready).announce('jobs', { rev });
  }

  return {
    server,
    accounts,
    notify,
    listen: ({ host, port }) => new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeAllListeners('error'); resolveListen(server.address().port); });
    }),
    async close() {
      clearInterval(sweeper);
      for (const slot of mounted.values()) (await slot.ready.catch(() => null))?.close();
      mounted.clear();
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}
