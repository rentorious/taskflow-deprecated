// The report's routes, over any backend.
//
// Read-only over pipeline state. The write routes record what a person did:
// inbox ticks and answers to questions. Where those live is the backend's
// business: files for the local report (backend-files.mjs), a database for the
// hosted one. Transport security (which Host, which Origin, which address to
// bind) belongs to whoever owns the socket and is handed in.
//
// The caller decodes the path once and passes it in; nothing here decodes again.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTaskDetail } from './model.mjs';
import { renderMarkdown } from './markdown.mjs';
import { attachmentType } from './read.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_BODY_BYTES = 16 * 1024;
const REBUILD_EVERY_MS = 30 * 1000; // lock ages cross thresholds without anything being written
const HEARTBEAT_MS = 25 * 1000;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

// Attachments come from the ticket provider. `sandbox` stops an SVG from
// running script even when it is opened directly in a tab.
const ATTACHMENT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function baseHeaders(extra = {}) {
  return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...extra };
}

export function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra }));
  res.end(JSON.stringify(body));
}

/** Stores reject with a plain Error carrying a 4xx status; anything else is ours to hide. */
export function sendError(res, error) {
  const status = error instanceof HttpError || (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) ? error.status : 500;
  if (status === 500) console.error(error);
  if (res.headersSent) return res.end();
  sendJson(res, status, { error: status === 500 ? 'The report hit an internal error. See the server log.' : error.message });
}

/** The files the page may load: fixed at startup, never derived from a request path. */
async function buildStaticMap() {
  const map = new Map([['/', 'index.html']]);
  for (const name of await readdir(UI_DIR).catch(() => [])) {
    if (STATIC_TYPES[extname(name)]) map.set(`/${name}`, name);
  }
  for (const name of await readdir(join(UI_DIR, 'fonts')).catch(() => [])) {
    if (STATIC_TYPES[extname(name)]) map.set(`/fonts/${name}`, join('fonts', name));
  }
  return map;
}

/**
 * @param {object} options
 * @param {object} options.backend   see backend-files.mjs for the shape
 * @param {{originAllowed?: (origin: string|undefined, req: object) => boolean}} [options.security]
 * @param {(actor: object|null, cycle: object) => boolean} [options.canWrite]  asked before a write body is read
 * @param {boolean} [options.legacyStatus]  serve the pre-rework /api/status, which returns the raw index
 */
export async function createReportHandler({ backend, security = {}, canWrite = () => true, legacyStatus = false }) {
  const originAllowed = security.originAllowed ?? (() => true);
  const staticMap = await buildStaticMap();
  const cycles = new Map();
  const clients = new Set();
  let lastBroadcast = null;
  let lastPushedAt = null;

  async function getCycle(id) {
    const known = await backend.listCycles();
    // Validate by enumerating what exists; a cycle id is never joined into a path or a query.
    const entry = known.find((c) => c.id === (id || 'live'));
    if (!entry) throw new HttpError(404, 'Unknown cycle.');
    if (!cycles.has(entry.id)) cycles.set(entry.id, { cycle: await backend.openCycle(entry), cache: null, building: null });
    return cycles.get(entry.id);
  }

  async function getState(id, { force = false } = {}) {
    const slot = await getCycle(id);
    if (slot.building) return slot.building;
    const signature = await slot.cycle.signature();
    const fresh = slot.cache && slot.cache.signature === signature && Date.now() - slot.cache.builtAt < REBUILD_EVERY_MS;
    if (fresh && !force) return slot.cache;

    slot.building = (async () => {
      const { raw, model } = await slot.cycle.build();
      slot.cache = { signature, builtAt: Date.now(), raw, model };
      return slot.cache;
    })().finally(() => { slot.building = null; });
    return slot.building;
  }

  // -- responses ---------------------------------------------------------------

  async function sendStatic(res, relative) {
    const path = join(UI_DIR, relative);
    const body = await readFile(path);
    const type = STATIC_TYPES[extname(path)];
    const headers = baseHeaders({ 'Content-Type': type });
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGE_CSP;
    if (type === 'font/woff2') headers['Cache-Control'] = 'public, max-age=86400';
    res.writeHead(200, headers);
    res.end(body);
  }

  async function sendAttachment(req, res, cycleId, taskId, name) {
    // The type comes from the name alone, through an allowlist. What the bytes claim to be is never asked.
    const type = SAFE_NAME.test(taskId) && SAFE_NAME.test(name) ? attachmentType(name) : null;
    if (!type) throw new HttpError(404, 'No such attachment.');
    const { cycle } = await getCycle(cycleId);
    const found = await cycle.openAttachment(taskId, name);
    if (!found) throw new HttpError(404, 'No such attachment.');

    const headers = baseHeaders({
      'Content-Type': type,
      'Content-Security-Policy': ATTACHMENT_CSP,
      'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, max-age=300',
    });
    if (found.etag) {
      headers.ETag = `"${found.etag}"`;
      if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
    }
    const body = await found.open();
    res.writeHead(200, headers);
    if (typeof body?.pipe === 'function') body.pipe(res);
    else res.end(body);
  }

  function readBody(req) {
    return new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'Request body too large.')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'Body is not valid JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  /** Every write route: JSON only, same origin only (CSRF), never on an archive. Returns the item it is about. */
  async function openWrite(req, ctx, cycleId) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send application/json.');
    if (!originAllowed(req.headers.origin, req)) throw new HttpError(403, 'Cross-origin writes are not allowed.');

    const { cycle } = await getCycle(cycleId);
    if (!canWrite(ctx.actor ?? null, cycle)) throw new HttpError(403, 'You cannot change anything here.');
    if (cycle.isArchive) throw new HttpError(403, 'This cycle is archived and read-only.');
    const body = await readBody(req);
    const { model } = await getState(cycleId);
    const item = model.inbox[body?.id];
    if (!item) throw new HttpError(404, 'That item is no longer in the inbox.');
    if (!item.tickable) throw new HttpError(400, 'This item clears itself once the underlying state is fixed.');
    return { human: cycle.human(ctx.actor ?? null), body, model, item };
  }

  async function sendItem(res, cycleId, id) {
    const next = await getState(cycleId, { force: true });
    broadcast(next.model.version);
    sendJson(res, 200, { ok: true, version: next.model.version, item: next.model.inbox[id] ?? null });
  }

  const stale = (body, item) => body.fingerprint !== item.fingerprint;
  const CHANGED = 'The item changed since you loaded it. Reload and try again.';

  async function handleInbox(req, res, ctx, cycleId) {
    const { human, body, model, item } = await openWrite(req, ctx, cycleId);
    const resolution = body.resolution ?? null;
    if (resolution !== null && !item.resolutions.includes(resolution)) {
      throw new HttpError(400, item.kind === 'question' && resolution === 'answered' ? 'A question is answered by saving an answer.' : `Use one of: ${item.resolutions.join(', ')}.`);
    }
    if (resolution !== null && stale(body, item)) throw new HttpError(409, CHANGED);

    await human.setResolution(item, { resolution, note: body.note }, model.cycle.lastTriage);
    await sendItem(res, cycleId, item.id);
  }

  async function handleAnswer(req, res, ctx, cycleId) {
    const { human, body, item } = await openWrite(req, ctx, cycleId);
    if (item.kind !== 'question') throw new HttpError(400, 'Only questions take answers.');
    if (stale(body, item)) throw new HttpError(409, CHANGED);
    await human.addAnswer(item, {
      body: body.body,
      source: body.source,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
      // Absent means "do not check"; null means "I had seen no answer yet".
      previousAnswerId: 'previousAnswerId' in body ? body.previousAnswerId : undefined,
      via: 'web',
    });
    await sendItem(res, cycleId, item.id);
  }

  /** The question was reworded and what is recorded on it still applies. */
  async function handleConfirm(req, res, ctx, cycleId) {
    const { human, body, item } = await openWrite(req, ctx, cycleId);
    if (item.kind !== 'question') throw new HttpError(400, 'Only questions can be confirmed.');
    if (item.state !== 'changed') throw new HttpError(400, 'This question has not changed since it was settled.');
    if (stale(body, item)) throw new HttpError(409, CHANGED);
    await human.confirm(item);
    await sendItem(res, cycleId, item.id);
  }

  // -- live updates ------------------------------------------------------------

  function broadcast(modelVersion) {
    if (modelVersion === lastBroadcast) return;
    lastBroadcast = modelVersion;
    for (const client of clients) client.write(`event: model\ndata: ${JSON.stringify({ version: modelVersion })}\n\n`);
  }

  /** A push that changed nothing leaves the model's version alone, but the page still shows how fresh the mirror is. */
  function announcePush(cycle) {
    if (!cycle.pushedAt || cycle.pushedAt === lastPushedAt) return;
    lastPushedAt = cycle.pushedAt;
    for (const client of clients) client.write(`event: pushed\ndata: ${JSON.stringify({ pushedAt: cycle.pushedAt, pushedFrom: cycle.pushedFrom })}\n\n`);
  }

  async function refreshLive() {
    if (clients.size === 0) return;
    try {
      const { model } = await getState('live', { force: true });
      broadcast(model.version);
      announcePush(model.cycle);
    } catch {
      // The next poll retries; a transient read error must not kill the stream.
    }
  }

  const watcher = backend.watch(refreshLive, { isActive: () => clients.size > 0 });
  const ticker = setInterval(refreshLive, REBUILD_EVERY_MS);
  ticker.unref();
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
  heartbeat.unref();

  /** Something that is not the model changed (a job, say): tell the open pages which, and let them fetch it. */
  function announce(name, data) {
    for (const client of clients) client.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function handleEvents(req, res) {
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }));
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  // -- routing -----------------------------------------------------------------

  /**
   * @param {object} ctx
   * @param {string} ctx.path   already decoded, and already stripped of any mount prefix
   * @param {URL} ctx.url
   * @param {object|null} [ctx.actor]  who is asking, when the transport knows
   */
  async function handle(req, res, ctx) {
    const { path, url } = ctx;
    const cycleId = url.searchParams.get('cycle') || 'live';

    if (req.method === 'POST' && path === '/api/inbox') return handleInbox(req, res, ctx, cycleId);
    if (req.method === 'POST' && path === '/api/answer') return handleAnswer(req, res, ctx, cycleId);
    if (req.method === 'POST' && path === '/api/answer/confirm') return handleConfirm(req, res, ctx, cycleId);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');

    if (staticMap.has(path)) return sendStatic(res, staticMap.get(path));

    if (path === '/api/events') return handleEvents(req, res);
    if (path === '/api/cycles') {
      return sendJson(res, 200, { cycles: (await backend.listCycles()).map((c) => ({ id: c.id, isArchive: c.isArchive, ...(c.label ? { label: c.label } : {}) })) });
    }
    if (path === '/api/model') {
      const { model } = await getState(cycleId);
      const etag = `"${model.version}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, baseHeaders({ ETag: etag })); return res.end(); }
      return sendJson(res, 200, model, { ETag: etag });
    }
    if (path === '/api/summary') {
      const { raw } = await getState(cycleId);
      if (!raw.summaryFile) return sendJson(res, 200, { file: null, html: '', truncated: false });
      const { cycle } = await getCycle(cycleId);
      return sendJson(res, 200, { file: raw.summaryFile, ...renderMarkdown(await cycle.readSummary(raw)) });
    }
    if (legacyStatus && path === '/api/status') {
      // Shape of the pre-rework endpoint, kept for anything scripted against it.
      const { raw } = await getState(cycleId);
      if (!raw.index) return sendJson(res, 404, { error: 'No triage data found' });
      const batches = {};
      for (const key of Object.keys(raw.index.batches ?? {})) {
        batches[key] = { ...(raw.batchFiles[key]?.data ?? { status: 'pending', branch: null, pr_url: null, tasks: {} }), locked: Boolean(raw.locks[key]) };
      }
      return sendJson(res, 200, { index: raw.index, batches });
    }

    const task = /^\/api\/task\/([^/]+)$/.exec(path);
    if (task) {
      if (!SAFE_NAME.test(task[1])) throw new HttpError(404, 'No such task.');
      const { raw } = await getState(cycleId);
      if (!raw.index?.tasks?.[task[1]]) throw new HttpError(404, 'No such task.');
      return sendJson(res, 200, buildTaskDetail(raw, task[1]));
    }

    const attachment = /^\/attachments\/([^/]+)\/([^/]+)$/.exec(path);
    if (attachment) return sendAttachment(req, res, cycleId, attachment[1], attachment[2]);

    throw new HttpError(404, 'Not found.');
  }

  return {
    handle,
    getState,
    /** Something was written that the backend's own watch may not have seen yet. */
    notify: refreshLive,
    announce,
    clientCount: () => clients.size,
    close() {
      watcher?.close?.();
      clearInterval(ticker);
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}
