// The job queue: what the page asks for, what a runner takes, and what it reports.
//
// Nothing here runs anything. A job is a row; a runner on the requesting developer's
// own machine leases it, launches claude, forwards the session's events, relays its
// questions, and reports how it ended. Every row is scoped to a project AND to the
// person who asked: a job runs only on that person's machines, so a teammate's
// token can neither take it nor report on it.

import { randomUUID } from 'node:crypto';
import { JOB_STATES, KINDS, OPEN_STATES, QUESTION_KINDS, compactEvent, compactResult, compactUsage, validateJob } from '../scripts/report/jobs.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVENTS_PER_POST = 200;
const MAX_WAIT_MS = 25_000;
const POLL_MS = 500;
const TAIL = 300;

const asUuid = (value, what) => {
  const text = String(value ?? '').toLowerCase();
  if (!UUID.test(text)) throw fail(400, `Not a ${what} id.`);
  return text;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Every job write bumps the project's jobs_rev, which is what the page's `jobs` event carries. */
async function touch(q, projectId) {
  return Number((await q.query('update project set jobs_rev = jobs_rev + 1 where id = $1 returning jobs_rev', [projectId])).rows[0]?.jobs_rev ?? 0);
}
const audit = (q, userId, projectId, action, payload) => q.query('insert into audit_log (user_id, project_id, action, payload) values ($1, $2, $3, $4)', [userId, projectId, action, JSON.stringify(payload)]);

/** A queued job nobody took in time is expired, lazily, whenever the queue is read. */
async function expireStale(q, projectId) {
  const { rows } = await q.query("update job set state = 'expired', finished_at = now() where project_id = $1 and state = 'queued' and expires_at < now() returning id", [projectId]);
  return rows.length;
}

function shapeJob(row) {
  return {
    id: row.id, projectId: row.project_id, cycleId: row.cycle_id, kind: row.kind, args: row.args, state: row.state,
    requestedBy: row.requested_by, requestedByLogin: row.requested_by_login ?? null, machineId: row.machine_id, machineName: row.machine_name ?? null,
    sessionId: row.session_id, result: row.result, error: row.error,
    createdAt: row.created_at, expiresAt: row.expires_at, leasedAt: row.leased_at, startedAt: row.started_at, finishedAt: row.finished_at,
    openQuestions: Number(row.open_questions ?? 0),
  };
}
function shapeQuestion(row) {
  return { id: row.id, jobId: row.job_id, kind: row.kind, question: row.question, answer: row.answer, answeredBy: row.answered_by, askedAt: row.asked_at, answeredAt: row.answered_at, parkedAt: row.parked_at };
}

const JOB_COLUMNS = `j.*, u.login as requested_by_login, m.name as machine_name,
  (select count(*) from job_question x where x.job_id = j.id and x.answered_at is null) as open_questions`;
const JOB_FROM = 'from job j join app_user u on u.id = j.requested_by left join machine m on m.id = j.machine_id';

/** The row as the page sees it: with the asker's login, the machine's name and the open question count. */
async function loadJob(q, id) {
  return shapeJob((await q.query(`select ${JOB_COLUMNS} ${JOB_FROM} where j.id = $1`, [id])).rows[0]);
}

async function ownMachine(q, { userId, machineId }, { lock = false } = {}) {
  const id = asUuid(machineId, 'machine');
  const row = (await q.query(`select * from machine where id = $1 and user_id = $2${lock ? ' for update' : ''}`, [id, userId])).rows[0];
  if (!row) throw fail(404, 'No such machine of yours. Register it first.');
  return row;
}

// -- machines ------------------------------------------------------------------------

/** A runner announces itself, or says it is still here. The id is minted once per machine and kept on that machine. */
export function registerMachine(db, { userId, id = null, name, kinds = [], concurrency = 1, runnerVersion = null }) {
  const label = String(name ?? '').trim().slice(0, 100);
  if (!label) throw fail(400, 'A machine needs a name.');
  const list = [...new Set((Array.isArray(kinds) ? kinds : []).map(String))].filter((k) => /^[a-z][a-z-]{1,30}$/.test(k));
  const slots = Math.min(8, Math.max(1, Number(concurrency) || 1));
  const machineId = id === null ? randomUUID() : asUuid(id, 'machine');
  return db.tx(async (q) => {
    const taken = (await q.query('select user_id from machine where id = $1', [machineId])).rows[0];
    if (taken && String(taken.user_id) !== String(userId)) throw fail(404, 'No such machine of yours.');
    const { rows } = await q.query(
      `insert into machine (id, user_id, name, kinds, concurrency, runner_version) values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set name = excluded.name, kinds = excluded.kinds, concurrency = excluded.concurrency, runner_version = excluded.runner_version, last_seen_at = now()
       returning *`,
      [machineId, userId, label, list, slots, runnerVersion ? String(runnerVersion).slice(0, 40) : null],
    );
    return shapeMachine(rows[0]);
  });
}
function shapeMachine(row) {
  return { id: row.id, name: row.name, kinds: row.kinds, concurrency: row.concurrency, runnerVersion: row.runner_version, usage: row.usage, pausedUntil: row.paused_until, lastSeenAt: row.last_seen_at, online: Date.now() - new Date(row.last_seen_at).getTime() < 90_000 };
}
export async function listMachines(db, { userId }) {
  return (await db.query('select * from machine where user_id = $1 order by name', [userId])).rows.map(shapeMachine);
}
/** The session reported how much of the plan's window is used; the runner may also pause itself until a reset. */
export function reportUsage(db, { userId, machineId, usage, pausedUntil = null }) {
  return db.tx(async (q) => {
    const machine = await ownMachine(q, { userId, machineId });
    const until = pausedUntil ? new Date(pausedUntil) : null;
    if (until && Number.isNaN(until.getTime())) throw fail(400, 'pausedUntil must be a date.');
    const { rows } = await q.query('update machine set usage = coalesce($3, usage), paused_until = $4, last_seen_at = now() where id = $1 and user_id = $2 returning *', [machine.id, userId, usage ? JSON.stringify(compactUsage(usage)) : null, until]);
    return shapeMachine(rows[0]);
  });
}

// -- the queue, from the page's side ---------------------------------------------------

export function requestJob(db, { projectId, userId, kind, args, machineId = null }) {
  const job = validateJob(kind, args);
  return db.tx(async (q) => {
    if (machineId !== null) await ownMachine(q, { userId, machineId });
    const live = (await q.query('select id from cycle where project_id = $1 and user_id = $2 and is_live', [projectId, userId])).rows[0];
    // One open job per (kind, args): a second Start on the same batch would only race the first.
    const dup = (await q.query('select id from job where project_id = $1 and requested_by = $2 and kind = $3 and args::text = $4 and state = any($5)', [projectId, userId, job.kind, JSON.stringify(job.args), OPEN_STATES])).rows[0];
    if (dup) throw fail(409, `That job is already queued or running (${dup.id}).`);
    const id = randomUUID();
    const ttlMs = KINDS[job.kind].ttlMs;
    await q.query(
      `insert into job (id, project_id, cycle_id, kind, args, requested_by, machine_id, expires_at) values ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' milliseconds')::interval)`,
      [id, projectId, live?.id ?? null, job.kind, JSON.stringify(job.args), userId, machineId, String(ttlMs)],
    );
    await audit(q, userId, projectId, 'job.request', { job: id, kind: job.kind, args: job.args });
    const rev = await touch(q, projectId);
    return { job: await loadJob(q, id), rev };
  });
}

export function cancelJob(db, { projectId, userId, jobId }) {
  const id = asUuid(jobId, 'job');
  return db.tx(async (q) => {
    const done = await q.query("update job set state = 'cancelled', finished_at = now() where id = $1 and project_id = $2 and requested_by = $3 and state = 'queued'", [id, projectId, userId]);
    if (!done.rowCount) throw fail(409, 'Only a queued job of yours can be cancelled.');
    await audit(q, userId, projectId, 'job.cancel', { job: id });
    const rev = await touch(q, projectId);
    return { job: await loadJob(q, id), rev };
  });
}

export async function listJobs(db, { projectId, userId, limit = 50 }) {
  await db.tx((q) => expireStale(q, projectId));
  const { rows } = await db.query(`select ${JOB_COLUMNS} ${JOB_FROM} where j.project_id = $1 and j.requested_by = $2 order by j.created_at desc limit $3`, [projectId, userId, Math.min(200, Math.max(1, Number(limit) || 50))]);
  const rev = Number((await db.query('select jobs_rev from project where id = $1', [projectId])).rows[0]?.jobs_rev ?? 0);
  return { jobs: rows.map(shapeJob), rev };
}

export async function getJob(db, { projectId, userId, jobId, after = 0 }) {
  const id = asUuid(jobId, 'job');
  const job = (await db.query(`select ${JOB_COLUMNS} ${JOB_FROM} where j.id = $1 and j.project_id = $2 and j.requested_by = $3`, [id, projectId, userId])).rows[0];
  if (!job) throw fail(404, 'No such job.');
  const events = (await db.query('select seq, at, event from job_event where job_id = $1 and seq > $2 order by seq desc limit $3', [id, Number(after) || 0, TAIL])).rows.reverse();
  const questions = (await db.query('select * from job_question where job_id = $1 order by asked_at', [id])).rows.map(shapeQuestion);
  const lastSeq = Number((await db.query('select coalesce(max(seq), 0) as last from job_event where job_id = $1', [id])).rows[0].last);
  return { job: shapeJob(job), events: events.map((e) => ({ seq: e.seq, at: e.at, ...e.event })), questions, lastSeq };
}

// -- the queue, from the runner's side -------------------------------------------------

/**
 * The next job this machine should run, or null. Queued jobs of this machine's owner first (pinned to it or to
 * nobody), then a parked job of this machine whose questions have all been answered, which resumes.
 */
export function leaseJob(db, { projectId, userId, machineId, kinds = [] }) {
  const wanted = (Array.isArray(kinds) ? kinds : []).map(String);
  return db.tx(async (q) => {
    const machine = await ownMachine(q, { userId, machineId }, { lock: true });
    await q.query('update machine set last_seen_at = now() where id = $1', [machine.id]);
    await expireStale(q, projectId);
    if (machine.paused_until && new Date(machine.paused_until) > new Date()) return { job: null, pausedUntil: machine.paused_until };
    const running = Number((await q.query("select count(*) from job where machine_id = $1 and state = 'running'", [machine.id])).rows[0].count);
    if (running >= machine.concurrency) return { job: null, busy: true };
    const take = wanted.filter((k) => machine.kinds.includes(k));
    if (take.length === 0) return { job: null };

    let row = (await q.query(
      `select * from job where project_id = $1 and requested_by = $2 and state = 'queued' and kind = any($3) and (machine_id is null or machine_id = $4)
       order by created_at limit 1 for update skip locked`,
      [projectId, userId, take, machine.id],
    )).rows[0];
    let resume = false;
    if (!row) {
      row = (await q.query(
        `select j.* from job j where j.project_id = $1 and j.machine_id = $2 and j.state = 'needs-input' and j.kind = any($3)
           and not exists (select 1 from job_question x where x.job_id = j.id and x.answered_at is null)
         order by j.created_at limit 1 for update skip locked`,
        [projectId, machine.id, take],
      )).rows[0];
      resume = Boolean(row);
    }
    if (!row) return { job: null };
    await q.query("update job set state = 'running', machine_id = $2, leased_at = now() where id = $1", [row.id, machine.id]);
    await audit(q, userId, projectId, resume ? 'job.resume' : 'job.lease', { job: row.id, machine: machine.id });
    const rev = await touch(q, projectId);
    const answers = resume ? (await q.query('select * from job_question where job_id = $1 and parked_at is not null and answered_at is not null order by asked_at', [row.id])).rows.map(shapeQuestion) : [];
    // A resumed session's events continue the numbering, or they would all be dropped as duplicates.
    const lastSeq = Number((await q.query('select coalesce(max(seq), 0) as last from job_event where job_id = $1', [row.id])).rows[0].last);
    return { job: await loadJob(q, row.id), resume, answers, lastSeq, rev };
  });
}

/** Long-poll wrapper: lease now, or keep trying for up to `waitMs`. */
export async function leaseJobWait(db, options, waitMs) {
  const until = Date.now() + Math.min(MAX_WAIT_MS, Math.max(0, Number(waitMs) || 0));
  for (;;) {
    const leased = await leaseJob(db, options);
    if (leased.job || leased.pausedUntil || Date.now() >= until) return leased;
    await sleep(1000);
  }
}

// running -> running is the runner naming the session it launched; the lease already made it running.
const TRANSITIONS = { running: ['running', 'needs-input', 'done', 'failed', 'refused'], 'needs-input': ['running', 'failed'] };

/** The runner says what became of a job it holds. */
export function reportJob(db, { projectId, userId, jobId, machineId, state, sessionId = null, result = null, error = null }) {
  const id = asUuid(jobId, 'job');
  if (!JOB_STATES.includes(state)) throw fail(400, `Not a job state: ${state}`);
  return db.tx(async (q) => {
    const machine = await ownMachine(q, { userId, machineId });
    const job = (await q.query('select * from job where id = $1 and project_id = $2 and machine_id = $3 for update', [id, projectId, machine.id])).rows[0];
    if (!job) throw fail(404, 'No such job on this machine.');
    if (!(TRANSITIONS[job.state] ?? []).includes(state)) throw fail(409, `A ${job.state} job cannot become ${state}.`);
    const terminal = !OPEN_STATES.includes(state);
    const session = sessionId === null ? job.session_id : asUuid(sessionId, 'session');
    await q.query(
      `update job set state = $2, session_id = $3, result = coalesce($4, result), error = $5,
         started_at = coalesce(started_at, case when $2 = 'running' then now() end), finished_at = case when $6 then now() else null end
       where id = $1`,
      [id, state, session, result ? JSON.stringify(compactResult(result)) : null, error ? String(error).slice(0, 2000) : null, terminal],
    );
    if (terminal) await audit(q, userId, projectId, 'job.' + state, { job: id, machine: machine.id, cost: result?.total_cost_usd ?? null });
    const rev = await touch(q, projectId);
    return { job: await loadJob(q, id), rev };
  });
}

/** A batch of the session's stream-json events, in order. Duplicates (a retried post) are ignored by (job, seq). */
export function appendEvents(db, { projectId, userId, jobId, machineId, events }) {
  const id = asUuid(jobId, 'job');
  if (!Array.isArray(events) || events.length === 0) return Promise.resolve({ stored: 0 });
  if (events.length > MAX_EVENTS_PER_POST) throw fail(413, `At most ${MAX_EVENTS_PER_POST} events per post.`);
  return db.tx(async (q) => {
    const machine = await ownMachine(q, { userId, machineId });
    const job = (await q.query("select state from job where id = $1 and project_id = $2 and machine_id = $3", [id, projectId, machine.id])).rows[0];
    if (!job) throw fail(404, 'No such job on this machine.');
    let stored = 0;
    for (const entry of events) {
      const seq = Number(entry?.seq);
      const event = compactEvent(entry?.event);
      if (!Number.isInteger(seq) || seq < 0 || !event) continue;
      const done = await q.query('insert into job_event (job_id, seq, event) values ($1, $2, $3) on conflict do nothing', [id, seq, JSON.stringify(event)]);
      stored += done.rowCount;
    }
    const rev = stored ? await touch(q, projectId) : null;
    return { stored, rev };
  });
}

// -- questions -------------------------------------------------------------------------

export function askQuestion(db, { projectId, userId, jobId, machineId, kind, question }) {
  const id = asUuid(jobId, 'job');
  if (!QUESTION_KINDS.includes(kind)) throw fail(400, `Not a question kind: ${kind}`);
  const body = shapeAsked(kind, question);
  return db.tx(async (q) => {
    const machine = await ownMachine(q, { userId, machineId });
    const job = (await q.query("select state from job where id = $1 and project_id = $2 and machine_id = $3", [id, projectId, machine.id])).rows[0];
    if (!job) throw fail(404, 'No such job on this machine.');
    if (job.state !== 'running') throw fail(409, `A ${job.state} job cannot ask.`);
    const qid = randomUUID();
    const { rows } = await q.query('insert into job_question (id, job_id, project_id, kind, question) values ($1, $2, $3, $4, $5) returning *', [qid, id, projectId, kind, JSON.stringify(body)]);
    const rev = await touch(q, projectId);
    return { question: shapeQuestion(rows[0]), rev };
  });
}
function shapeAsked(kind, question) {
  if (kind === 'ask') {
    const text = String(question?.text ?? '').trim().slice(0, 4000);
    if (!text) throw fail(400, 'A question needs text.');
    const options = Array.isArray(question?.options) ? question.options.map((o) => String(o).slice(0, 200)).filter(Boolean).slice(0, 8) : [];
    return { text, options };
  }
  const tool = String(question?.tool ?? '').slice(0, 100);
  if (!tool) throw fail(400, 'A permission question names the tool.');
  const input = typeof question?.input === 'string' ? question.input.slice(0, 2000) : JSON.stringify(question?.input ?? {}).slice(0, 2000);
  return { tool, input, reason: String(question?.reason ?? '').slice(0, 500) };
}

/** The session waits here, one poll at a time, until the person answers or `waitMs` passes. */
export async function awaitAnswer(db, { projectId, userId, jobId, questionId, waitMs }) {
  const id = asUuid(jobId, 'job');
  const qid = asUuid(questionId, 'question');
  const until = Date.now() + Math.min(MAX_WAIT_MS, Math.max(0, Number(waitMs) || 0));
  for (;;) {
    const row = (await db.query(
      'select x.* from job_question x join job j on j.id = x.job_id join machine m on m.id = j.machine_id where x.id = $1 and x.job_id = $2 and x.project_id = $3 and m.user_id = $4',
      [qid, id, projectId, userId],
    )).rows[0];
    if (!row) throw fail(404, 'No such question.');
    if (row.answered_at || Date.now() >= until) return { question: shapeQuestion(row), answered: Boolean(row.answered_at) };
    await sleep(POLL_MS);
  }
}

/** The session gave up waiting: the job is parked until the answer arrives, then resumed by the runner (leaseJob). */
export function parkQuestion(db, { projectId, userId, jobId, machineId, questionId }) {
  const id = asUuid(jobId, 'job');
  const qid = asUuid(questionId, 'question');
  return db.tx(async (q) => {
    const machine = await ownMachine(q, { userId, machineId });
    const { rows } = await q.query('update job_question x set parked_at = coalesce(x.parked_at, now()) from job j where x.id = $1 and x.job_id = $2 and j.id = x.job_id and j.project_id = $3 and j.machine_id = $4 returning x.*', [qid, id, projectId, machine.id]);
    if (!rows.length) throw fail(404, 'No such question.');
    await q.query("update job set state = 'needs-input' where id = $1 and state = 'running'", [id]);
    const rev = await touch(q, projectId);
    return { question: shapeQuestion(rows[0]), rev };
  });
}

/** A person answered, in the browser. Any developer of the project may; the answer records who. */
export function answerQuestion(db, { projectId, userId, jobId, questionId, answer }) {
  const id = asUuid(jobId, 'job');
  const qid = asUuid(questionId, 'question');
  return db.tx(async (q) => {
    const row = (await q.query('select * from job_question where id = $1 and job_id = $2 and project_id = $3 for update', [qid, id, projectId])).rows[0];
    if (!row) throw fail(404, 'No such question.');
    if (row.answered_at) throw fail(409, 'Already answered.');
    const body = shapeAnswer(row.kind, answer);
    const { rows } = await q.query('update job_question set answer = $2, answered_by = $3, answered_at = now() where id = $1 returning *', [qid, JSON.stringify(body), userId]);
    await audit(q, userId, projectId, 'job.answer', { job: id, question: qid, kind: row.kind, ...(row.kind === 'permission' ? { decision: body.decision } : {}) });
    const rev = await touch(q, projectId);
    return { question: shapeQuestion(rows[0]), rev };
  });
}
function shapeAnswer(kind, answer) {
  if (kind === 'ask') {
    const text = String(answer?.text ?? '').trim().slice(0, 8000);
    if (!text) throw fail(400, 'An answer needs text.');
    return { text };
  }
  const decision = String(answer?.decision ?? '');
  if (!['allow', 'deny'].includes(decision)) throw fail(400, 'A permission is answered allow or deny.');
  return { decision, ...(answer?.note ? { note: String(answer.note).slice(0, 500) } : {}) };
}
