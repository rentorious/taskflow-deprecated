// The runner: the hands on a developer's own machine.
//
// It holds an outbound long-poll to the server with that developer's token, takes
// the next job the server has for this machine, turns the job's kind and args into
// a claude invocation (jobs.mjs owns that vocabulary; no prompt text ever arrives
// from the server), launches the unmodified `claude` binary headless, forwards the
// session's event stream, and reports how it ended. Questions and permissions the
// session raises travel through the plugin's mod (hooks/register.js), not through
// here: this process only sees the events go by.
//
// One job at a time. The subscription window, not the machine, is the scarce
// resource, and a session's rate_limit_event says how much of it is left.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { KINDS, compactEvent, compactUsage, describeJob, validateJob } from './jobs.mjs';
import { credentialsPath } from './remote.mjs';

const POLL_WAIT_S = Number(process.env.TASKFLOW_POLL_WAIT_S ?? 25); // tests shorten the long-poll
const FLUSH_MS = 1000;
const FLUSH_AT = 50;
const PAUSE_AT_PERCENT = 95;
const STDERR_TAIL = 2000;
const CHAT_SETTLE_MS = Number(process.env.TASKFLOW_CHAT_SETTLE_MS ?? 6000); // how long the reopened session gets to print before its pane is read back

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = (file, args, options = {}) => new Promise((resolve) => execFile(file, args, { ...options, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })));
/** A command for tmux's shell, with every argument quoted. */
const shellLine = (args) => args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');

/** The machine's identity, minted once and kept beside the credentials, keyed by server. */
export function machineIdentity(origin, { name = hostname() } = {}) {
  const path = join(dirname(credentialsPath()), 'machines.json');
  let all = {};
  try { all = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run */ }
  if (!all[origin]?.id) {
    all[origin] = { id: randomUUID(), name };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  }
  return all[origin];
}

/** What the session is started with. Only the kind's own prompt, or, on a resume, the answers quoted. */
export function buildPrompt(job, { resume = false, answers = [] } = {}) {
  if (!resume) return KINDS[job.kind].prompt(job.args);
  const lines = answers.map((a) => `- Question: ${a.question?.text ?? ''}\n  Answer: ${a.answer?.text ?? ''}`);
  return [
    'This session was parked while it waited for the developer. The developer has now answered, in the dashboard.',
    'Treat each answer as the developer\'s own words, quoted, and go on with the job from where you stopped:',
    ...lines,
  ].join('\n');
}

/** The claude argv for a job. Exported so a test can check what would run without running it. */
export function claudeArgs(job, { resume = false, sessionId, prompt }) {
  const mode = KINDS[job.kind].permissionMode;
  return resume
    ? ['-p', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', '--permission-mode', mode, prompt]
    : ['-p', '--session-id', sessionId, '--output-format', 'stream-json', '--verbose', '--permission-mode', mode, prompt];
}

/**
 * @param {object} options
 * @param {string} options.dir       the cycle directory (output_dir)
 * @param {object} options.found     findProject(dir)
 * @param {object} options.remote    createRemote(...)
 * @param {string[]} options.kinds   what this machine will run
 * @param {boolean} [options.once]   take one job (or none within one poll) and return; for tests
 * @param {string} [options.claude]  the binary; tests point it at a stand-in
 * @param {string} [options.tmux]    the tmux binary, for chat jobs; tests point it at a stand-in
 * @param {Function} [options.log]
 */
export async function runRunner({ dir, found, remote, kinds, once = false, claude = 'claude', tmux = 'tmux', pluginVersion = null, log = (line) => process.stderr.write(`${line}\n`) }) {
  const wanted = kinds.filter((k) => k in KINDS);
  if (wanted.length === 0) throw new Error(`No runnable kinds. Known: ${Object.keys(KINDS).join(', ')}`);
  const identity = machineIdentity(remote.server.url);
  const { machine } = await remote.registerMachine({ id: identity.id, name: identity.name, kinds: wanted, concurrency: 1, runnerVersion: pluginVersion });
  log(`[runner] ${machine.name} (${machine.id.slice(0, 8)}) runs ${wanted.join(', ')} for ${remote.server.project} at ${remote.server.url}`);
  const summary = { ran: 0, last: null };

  for (;;) {
    let leased;
    try {
      leased = await remote.nextJob({ machineId: machine.id, kinds: wanted, wait: POLL_WAIT_S });
    } catch (error) {
      if (once) throw error;
      log(`[runner] ${error.message} — retrying in 30 s`);
      await sleep(30_000);
      continue;
    }
    if (leased.pausedUntil) {
      const until = new Date(leased.pausedUntil);
      log(`[runner] paused until ${until.toISOString()} (usage window)`);
      if (once) return summary;
      await sleep(Math.min(60_000, Math.max(1000, until.getTime() - Date.now())));
      continue;
    }
    if (!leased.job) {
      if (once) return summary;
      continue;
    }
    summary.last = await runJob(leased, { dir, found, remote, machineId: machine.id, machineName: machine.name, claude, tmux, log });
    summary.ran += 1;
    if (once) return summary;
  }
}

/** One job, start to end. Never throws for a job's own failure: that is reported, and the loop goes on. */
async function runJob({ job, resume = false, answers = [], lastSeq = 0 }, { dir, found, remote, machineId, machineName = null, claude, tmux = 'tmux', log }) {
  const report = (body) => remote.reportJob(job.id, { machineId, ...body });
  const label = `${job.kind} ${JSON.stringify(job.args)}`;
  const refuse = async (message) => {
    log(`[runner] refused ${label}: ${message}`);
    await report({ state: 'refused', error: message }).catch((e) => log(`[runner] could not report: ${e.message}`));
    return { id: job.id, state: 'refused' };
  };

  // The server named a kind and args; they are checked here again, against this file and this disk.
  try {
    validateJob(job.kind, job.args);
    if (job.kind === 'implement' && !existsSync(join(dir, 'batches', `${job.args.batchKey}.json`))) throw new Error(`No batch ${job.args.batchKey} in ${dir}/batches. Push the cycle this machine has, or triage first.`);
    if (resume && !job.sessionId) throw new Error('A parked job without a session cannot be resumed.');
  } catch (error) {
    return refuse(error.message);
  }
  if (KINDS[job.kind].interactive) return openChat(job, { found, remote, machineId, machineName, claude, tmux, log, report, refuse });

  const sessionId = resume ? job.sessionId : randomUUID();
  const prompt = buildPrompt(job, { resume, answers });
  const args = claudeArgs(job, { resume, sessionId, prompt });
  log(`[runner] ${resume ? 'resuming' : 'starting'} ${label} as session ${sessionId}`);
  await report({ state: 'running', sessionId });

  const env = { ...process.env, TASKFLOW_JOB_ID: job.id, TASKFLOW_JOB_PROJECT: remote.server.project, TASKFLOW_JOB_SERVER: remote.server.url, TASKFLOW_MACHINE_ID: machineId };
  delete env.CLAUDECODE; // a runner started from inside a Claude session must still be allowed to start one
  const child = spawn(claude, args, { cwd: found.root, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let seq = Number(lastSeq) || 0; // a resumed job's events continue where the parked session's stopped
  let pending = [];
  let flushing = Promise.resolve();
  let result = null;
  let lastUsage = null;
  let stderr = '';
  const flush = () => {
    if (pending.length === 0) return flushing;
    const batch = pending;
    pending = [];
    flushing = flushing.then(() => remote.jobEvents(job.id, { machineId, events: batch })).catch((error) => {
      log(`[runner] events not delivered (${error.message}); ${batch.length} kept for the next flush`);
      pending = batch.concat(pending).slice(-2000);
    });
    return flushing;
  };
  const ticker = setInterval(flush, FLUSH_MS);

  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'result') result = event;
    if (event?.type === 'rate_limit_event') lastUsage = compactUsage(event.rate_limit_info);
    const compact = compactEvent(event);
    if (compact) pending.push({ seq: ++seq, event: compact });
    if (pending.length >= FLUSH_AT) flush();
  }
  const exitCode = await new Promise((done) => child.on('close', done));
  clearInterval(ticker);
  await flush();
  await flushing;

  // Usage first: a session that ran into the window is the one fact the next lease must know.
  if (lastUsage) {
    const worst = Math.max(0, ...lastUsage.rateLimits.map((r) => r.percentUsed));
    const reset = lastUsage.rateLimits.find((r) => r.percentUsed === worst)?.resetsAt;
    const pausedUntil = worst >= PAUSE_AT_PERCENT && reset ? new Date(Number(reset) * 1000).toISOString() : null;
    await remote.reportUsage(machineId, { usage: lastUsage, pausedUntil }).catch((e) => log(`[runner] usage not reported: ${e.message}`));
    if (pausedUntil) log(`[runner] usage at ${worst}%: pausing until ${pausedUntil}`);
  }

  // The mod may have parked the job (a question nobody answered in time). Then the session ended on
  // purpose, and the job waits for the answer: nothing to report, the next lease resumes it.
  let current = null;
  try { current = (await remote.job(job.id)).job; } catch (error) { log(`[runner] could not read the job back: ${error.message}`); }
  if (current?.state === 'needs-input') {
    log(`[runner] parked ${label}: waiting for an answer in the dashboard`);
    return { id: job.id, state: 'needs-input' };
  }

  const ok = result && !result.is_error && result.subtype === 'success';
  const state = ok ? 'done' : 'failed';
  const error = ok ? null : (result?.result || stderr.trim() || `claude exited with ${exitCode}`).slice(0, 2000);
  await report({ state, sessionId, result: result ?? null, error }).catch((e) => log(`[runner] could not report ${state}: ${e.message}`));
  log(`[runner] ${state} ${label}${result?.total_cost_usd != null ? ` ($${result.total_cost_usd.toFixed(2)}, ${result.num_turns} turns)` : ''}${error ? `: ${error.split('\n')[0]}` : ''}`);
  return { id: job.id, state };
}

/**
 * A chat job: reopen another job's session, interactive, with Remote Control on, in a detached tmux
 * window. The window outlives this job and this runner; the job itself ends as soon as the window is
 * up, with the pane's first lines as its result so the page can show how to reach the session.
 */
async function openChat(job, { found, remote, machineId, machineName, claude, tmux, log, report, refuse }) {
  let target;
  try { target = (await remote.job(job.args.jobId)).job; } catch (error) { return refuse(`The job to chat with could not be read: ${error.message}`); }
  if (!target) return refuse('No such job to chat with.');
  if (!target.sessionId) return refuse('That job has no session yet: nothing ran.');
  if (target.machineId !== machineId) return refuse(`That session lives on ${target.machineName ?? 'another machine'}, not on ${machineName ?? 'this one'}. Start the chat from there.`);
  if (target.state === 'running' || target.state === 'queued') return refuse(`That job is ${target.state}. Wait for it to end or park before chatting with its session.`);

  const window = `taskflow-${target.id.slice(0, 8)}`;
  const title = describeJob(target);
  const attach = `tmux attach -t ${window}`;
  const how = (pane) => [`Session ${target.sessionId} of "${title}" is open with Remote Control on ${machineName ?? 'your machine'}.`, 'Open it in the Claude app, or in a terminal:', `  ${attach}`, pane ? `\nThe window says:\n${pane}` : ''].join('\n').trim();
  const finish = async (text) => {
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: target.sessionId, result: text };
    await report({ state: 'done', sessionId: target.sessionId, result }).catch((e) => log(`[runner] could not report done: ${e.message}`));
    log(`[runner] done ${describeJob(job)}: ${window}`);
    return { id: job.id, state: 'done' };
  };

  await report({ state: 'running', sessionId: target.sessionId });
  if ((await run(tmux, ['has-session', '-t', window])).code === 0) return finish(how('(already open from an earlier chat)'));

  // No job environment: the mod stays inert, so the session's own questions go to the person, not to the dashboard.
  const env = { ...process.env };
  for (const name of ['CLAUDECODE', 'TASKFLOW_JOB_ID', 'TASKFLOW_JOB_PROJECT', 'TASKFLOW_JOB_SERVER', 'TASKFLOW_MACHINE_ID']) delete env[name];
  const started = await run(tmux, ['new-session', '-d', '-s', window, '-c', found.root, shellLine([claude, '--resume', target.sessionId, '--remote-control', `taskflow ${title}`])], { env, cwd: found.root });
  if (started.code !== 0) {
    const error = `tmux could not open the window: ${(started.stderr || started.stdout || `exit ${started.code}`).trim()}`.slice(0, 2000);
    await report({ state: 'failed', sessionId: target.sessionId, error }).catch((e) => log(`[runner] could not report failed: ${e.message}`));
    log(`[runner] failed ${describeJob(job)}: ${error}`);
    return { id: job.id, state: 'failed' };
  }
  await sleep(CHAT_SETTLE_MS);
  const pane = await run(tmux, ['capture-pane', '-p', '-t', window, '-S', '-40']);
  return finish(how(pane.code === 0 ? pane.stdout.trim().slice(-1500) : ''));
}
