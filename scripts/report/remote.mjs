// The CLI's side of a hosted project: where the server is, which token to show
// it, and the few calls the pipeline makes. Zero dependencies: global fetch.
//
// A project is hosted when its .claude/taskflow-config.json says
//   "server": { "url": "https://flow.example.com", "project": "harbor-books" }
// No secret lives there. The token sits in ~/.config/taskflow/credentials.json
// (mode 0600), keyed by the server's origin, or in TASKFLOW_TOKEN.
//
// Anything that keeps the server from answering properly (no network, no token, a
// refused token, a 5xx) is one kind of failure, `unreachable`: the claim gate's
// data lives on the server, so without it nothing may start.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureCycleId, readCycleId } from './cycle-id.mjs';
import { buildPayload } from './payload.mjs';
import { createReader, findProject } from './read.mjs';
import { tickFileName } from './ticks.mjs';

const TIMEOUT_MS = 30 * 1000;

export class RemoteError extends Error {
  constructor(message, { status = null, unreachable = false } = {}) {
    super(message);
    this.status = status;
    this.unreachable = unreachable;
  }
}

export const credentialsPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'taskflow', 'credentials.json');

export async function readToken(origin) {
  if (process.env.TASKFLOW_TOKEN) return process.env.TASKFLOW_TOKEN;
  try {
    return JSON.parse(await readFile(credentialsPath(), 'utf8'))[origin]?.token ?? null;
  } catch {
    return null;
  }
}

export async function saveToken(origin, token) {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let all = {};
  try { all = JSON.parse(await readFile(path, 'utf8')); } catch { /* first token on this machine */ }
  all[origin] = { token, saved_at: new Date().toISOString() };
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
  return path;
}

/**
 * @param {{url: string, project: string}} server
 * @param {string|null} token
 */
export function createRemote(server, token) {
  async function call(method, path, { json, bytes, plain = false } = {}) {
    if (!token) throw new RemoteError(`No token for ${server.url}. Create one under Settings there, then run: taskflow.mjs login ${server.url}`, { unreachable: true });
    let res;
    try {
      res = await fetch(new URL(path, server.url), {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : bytes ? { 'Content-Type': 'application/octet-stream' } : {}) },
        body: json !== undefined ? JSON.stringify(json) : bytes,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new RemoteError(`${server.url} is not answering (${error.cause?.code ?? error.name}).`, { unreachable: true });
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const reason = body.error || `HTTP ${res.status}`;
    if (res.status === 401) throw new RemoteError(`${server.url} refused the token: ${reason} Run: taskflow.mjs login ${server.url}`, { status: 401, unreachable: true });
    // `plain`: a route where 404 means "no such job or machine", not "no such project".
    if (res.status === 404 && !plain) throw new RemoteError(`${server.url} knows no project "${server.project}" that you belong to.`, { status: 404, unreachable: true });
    if (res.status === 429 || res.status >= 500) throw new RemoteError(`${server.url} could not answer: ${reason}`, { status: res.status, unreachable: true });
    throw new RemoteError(reason, { status: res.status });
  }
  const at = (path) => `/api/p/${server.project}/${path}`;

  return {
    server,
    me: () => call('GET', '/api/me'),
    state: () => call('GET', at('state')),
    claim: (options) => call('POST', at('claim'), { json: { ...options, host: hostname() } }),
    release: (batchKey) => call('POST', at('release'), { json: { batchKey } }),
    archive: (cycleId) => call('POST', at('archive'), { json: { cycleId } }),
    importLocal: (answers, ticks) => call('POST', at('import'), { json: { answers, ticks } }),

    // -- the runner's side of the job queue --
    registerMachine: (machine) => call('POST', at('machines'), { json: machine }),
    reportUsage: (machineId, body) => call('POST', at(`machines/${machineId}/usage`), { json: body, plain: true }),
    nextJob: (body) => call('POST', at('jobs/next'), { json: body, plain: true }),
    job: (jobId) => call('GET', at(`jobs/${jobId}`), { plain: true }),
    jobEvents: (jobId, body) => call('POST', at(`jobs/${jobId}/events`), { json: body, plain: true }),
    reportJob: (jobId, body) => call('POST', at(`jobs/${jobId}/state`), { json: body, plain: true }),

    /**
     * The cycle as it is on disk right now, then whatever blobs the server lacks. Safe to repeat.
     * @returns {Promise<{cycleUuid: string, changed: boolean, uploaded: number, archived: string|null}>}
     */
    async push({ dir, slug = null, pluginVersion = null, enrich = true }) {
      const found = findProject(dir);
      const raw = await createReader(dir, { slug, config: found.config }).read();
      if (!raw.index) throw new RemoteError('No triage state found. Run /taskflow:triage first.', { status: 409 });
      const cycleId = await ensureCycleId(dir, raw.cycle.slug);

      let enrichment = null;
      if (enrich) {
        // Pull request and worktree state can only be seen from here: the server holds no repository token.
        const { createEnricher } = await import('./enrich.mjs');
        const enricher = createEnricher();
        enricher.snapshot(raw, found.root);
        await enricher.settle();
        enrichment = enricher.snapshot(raw, found.root);
        enricher.close();
      }

      const { payload, blobs } = await buildPayload({ raw, cycleId, enrichment, host: hostname(), pluginVersion });
      const result = await call('PUT', at('sync/cycle'), { json: payload });
      for (const hash of result.missing) await call('PUT', at(`sync/blob/${hash}`), { bytes: await blobs.get(hash).read() });
      return { cycleUuid: result.cycleUuid, changed: result.changed, uploaded: result.missing.length, archived: result.archived, slug: raw.cycle.slug };
    },

    /** One time: what was recorded locally moves to the server, and the local file steps aside. */
    async importAnswers({ dir, slug }) {
      const answersPath = join(dir, 'answers.json');
      const read = (path) => readFile(path, 'utf8').then(JSON.parse).catch(() => null);
      const [answers, ticks] = await Promise.all([read(answersPath), read(join(dir, tickFileName(slug)))]);
      const report = await call('POST', at('import'), { json: { answers, ticks } });
      // The server owns answers from here on. A file left in place would look like the truth to the next person.
      if (answers) await rename(answersPath, `${answersPath}.imported-${new Date().toISOString().slice(0, 10)}`);
      return report;
    },

    cycleId: (dir, slug) => readCycleId(dir, slug),
  };
}
