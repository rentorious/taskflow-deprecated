// The runner as a child process against a hosted app, with a stand-in `claude`: it
// registers its machine, takes only what the page queued for this developer, launches
// the right command, forwards the events, relays a question and its answer, parks a
// job nobody answered and resumes it, and reports failures and usage.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { specs } from '../../test/fixtures/specs.mjs';
import { materialize } from '../../test/helpers/cycle.mjs';
import { profile, startHosted } from './helpers/hosted.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'scripts', 'taskflow.mjs');
const FAKE = join(HERE, '..', '..', 'test', 'helpers', 'fake-claude.mjs');
const FAKE_TMUX = join(HERE, '..', '..', 'test', 'helpers', 'fake-tmux.mjs');
const NOW = Date.UTC(2026, 1, 4, 12, 0, 0);

function run(args, { cwd, home, env = {}, stdin = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, XDG_CONFIG_HOME: home, TASKFLOW_TOKEN: '', TASKFLOW_POLL_WAIT_S: '1', TASKFLOW_CLAUDE: FAKE, TASKFLOW_TMUX: FAKE_TMUX, TASKFLOW_CHAT_SETTLE_MS: '50', ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, text: stdout + stderr }));
    child.stdin.end(stdin);
  });
}
const until = async (check, { timeoutMs = 8000, every = 100 } = {}) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, every));
  }
};

describe('the runner', () => {
  let h; let ann; let root; let home;
  const api = (path) => `/api/p/harbor/${path}`;
  const runner = (extra = {}) => run(['runner', '--once', '--kinds', 'implement'], { cwd: root, home, ...extra });
  const request = async (batchKey) => (await (await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey } } })).json()).job;
  const jobOf = async (id) => (await ann.get(api(`jobs/${id}`))).json();

  before(async () => {
    h = await startHosted({ admins: ['ann'] });
    ann = h.browser(); await ann.signIn(profile('ann'));
    await ann.post('/settings/projects', { form: { id: 'harbor', name: 'Harbor Books' } });
    const token = /tfp_[A-Za-z0-9_-]+/.exec(await (await ann.post('/settings/tokens', { form: { label: 'laptop' } })).text())[0];
    root = await mkdtemp(join(tmpdir(), 'taskflow-runner-'));
    home = join(root, '.xdg');
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'taskflow-config.json'), JSON.stringify({ project_name: 'Harbor Books', output_dir: 'out', base_branch: 'dev', server: { url: h.origin, project: 'harbor' } }));
    await materialize(specs.questions, join(root, 'out'), NOW);
    const login = await run(['login', h.origin], { cwd: root, home, stdin: `${token}\n` });
    assert.equal(login.code, 0, login.text);
  });
  after(async () => { await h.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });

  test('with nothing queued it registers the machine and returns', async () => {
    const res = await runner();
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /Ran 0 jobs/);
    const { machines } = await (await ann.get(api('machines'))).json();
    assert.equal(machines.length, 1);
    assert.deepEqual(machines[0].kinds, ['implement']);
    const again = await runner();
    assert.equal((await (await ann.get(api('machines'))).json()).machines.length, 1, 'the same machine, not a second one');
    assert.equal(again.code, 0);
  });

  test('a queued implement job runs the right command headless and ends done, with its events and cost', async () => {
    const job = await request('batch-2');
    const res = await runner();
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /Ran 1 job/);
    const detail = await jobOf(job.id);
    assert.equal(detail.job.state, 'done');
    assert.equal(detail.job.result.total_cost_usd, 0.42);
    assert.equal(detail.job.result.result, 'Opened PR #1');
    assert.ok(detail.job.sessionId, 'the runner named the session it minted');
    assert.equal(detail.events[0].subtype, 'init');
    assert.equal(detail.events[0].permissionMode, 'acceptEdits', 'acceptEdits, never bypass');
    assert.ok(detail.events[1].content, JSON.stringify(detail.events.map((e) => [e.seq, e.type, e.subtype])));
    assert.match(detail.events[1].content[0].text, /^prompt: \/taskflow:implement batch-2$/, 'the prompt is built here, from the kind and args');
    assert.equal(detail.events.at(-1).type, 'result');
    const { machines } = await (await ann.get(api('machines'))).json();
    assert.equal(machines[0].usage.rateLimits[0].percentUsed, 30);
  });

  test('a triage job waits for a runner that lists the kind, then runs /taskflow:triage', async () => {
    const job = (await (await ann.post(api('jobs'), { json: { kind: 'triage', args: {} } })).json()).job;
    assert.ok(job?.id, 'a triage needs no args');
    let res = await runner();
    assert.equal(res.code, 0, res.text);
    assert.equal((await jobOf(job.id)).job.state, 'queued', 'an implement-only runner leaves it for a machine that runs triage');
    res = await run(['runner', '--once', '--kinds', 'implement,triage'], { cwd: root, home });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /Ran 1 job/);
    const detail = await jobOf(job.id);
    assert.equal(detail.job.state, 'done');
    assert.equal(detail.events[0].permissionMode, 'acceptEdits');
    assert.match(detail.events[1].content[0].text, /^prompt: \/taskflow:triage$/, 'no args, so the prompt is the bare skill');
    const { machines } = await (await ann.get(api('machines'))).json();
    assert.deepEqual(machines[0].kinds, ['implement', 'triage'], 'the machine now advertises both');
  });

  test('a chat job reopens an ended session in a tmux window with Remote Control, on the machine that ran it', async () => {
    const { machines } = await (await ann.get(api('machines'))).json();
    const ended = (await (await ann.get(api('jobs'))).json()).jobs.find((j) => j.kind === 'implement' && j.state === 'done' && j.sessionId);
    assert.ok(ended, 'an implement job ended earlier in this suite');
    const chat = (await (await ann.post(api('jobs'), { json: { kind: 'chat', args: { jobId: ended.id }, machineId: machines[0].id } })).json()).job;
    assert.equal(chat.machineId, machines[0].id, 'pinned to the machine that holds the session');
    const tmuxLog = join(root, 'tmux.log');
    const res = await run(['runner', '--once', '--kinds', 'implement,triage,chat'], { cwd: root, home, env: { FAKE_TMUX_LOG: tmuxLog } });
    assert.equal(res.code, 0, res.text);
    const detail = await jobOf(chat.id);
    assert.equal(detail.job.state, 'done', detail.job.error ?? '');
    assert.equal(detail.job.sessionId, ended.sessionId, 'the chat job names the session it opened');
    const started = readFileSync(tmuxLog, 'utf8').trim();
    assert.match(started, new RegExp(`^new-session -d -s taskflow-${ended.id.slice(0, 8)} -c ${root} '${FAKE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' '--resume' '${ended.sessionId}' '--remote-control' 'taskflow implement batch-2'$`), started);
    assert.match(detail.job.result.result, /Remote Control on laptop|Remote Control on /);
    assert.match(detail.job.result.result, new RegExp(`tmux attach -t taskflow-${ended.id.slice(0, 8)}`));
    assert.match(detail.job.result.result, /claude\.ai\/code\/remote\/fake-pairing/, 'the pane is read back for the page');
    assert.equal(detail.events.length, 0, 'no stream: nothing headless ran');

    const again = (await (await ann.post(api('jobs'), { json: { kind: 'chat', args: { jobId: ended.id }, machineId: machines[0].id } })).json()).job;
    await run(['runner', '--once', '--kinds', 'chat'], { cwd: root, home, env: { FAKE_TMUX_LOG: tmuxLog } });
    assert.match((await jobOf(again.id)).job.result.result, /already open/, 'a second chat finds the window and does not start another');
    assert.equal(readFileSync(tmuxLog, 'utf8').trim().split('\n').length, 1);
  });

  test('a chat with a job that never ran is refused', async () => {
    const queued = await request('batch-5');
    const chat = (await (await ann.post(api('jobs'), { json: { kind: 'chat', args: { jobId: queued.id } } })).json()).job;
    const res = await run(['runner', '--once', '--kinds', 'chat'], { cwd: root, home });
    assert.equal(res.code, 0, res.text);
    const detail = await jobOf(chat.id);
    assert.equal(detail.job.state, 'refused');
    assert.match(detail.job.error, /no session yet/);
    await ann.post(api(`jobs/${queued.id}/cancel`), { json: {} });
  });

  test('a batch this machine does not have is refused, not run', async () => {
    const job = await request('batch-404');
    const res = await runner();
    assert.equal(res.code, 0, res.text);
    const detail = await jobOf(job.id);
    assert.equal(detail.job.state, 'refused');
    assert.match(detail.job.error, /No batch batch-404/);
    assert.equal(detail.events.length, 0);
  });

  test('a question reaches the page while the session waits, and the answer reaches the session', async () => {
    const job = await request('batch-3');
    const running = runner({ env: { FAKE_CLAUDE_SCENARIO: 'ask' } });
    const q = await until(async () => (await jobOf(job.id)).questions.find((x) => !x.answeredAt));
    assert.equal(q.kind, 'ask');
    assert.deepEqual(q.question.options, ['red', 'blue']);
    assert.equal((await jobOf(job.id)).job.state, 'running');
    const res = await ann.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { text: 'blue' } } });
    assert.equal(res.status, 200);
    const out = await running;
    assert.equal(out.code, 0, out.text);
    const detail = await jobOf(job.id);
    assert.equal(detail.job.state, 'done');
    assert.equal(detail.job.result.result, 'Answer was: blue');
  });

  test('a question nobody answers parks the job; the answer later resumes the same session', async () => {
    const job = await request('batch-4');
    let res = await runner({ env: { FAKE_CLAUDE_SCENARIO: 'ask', FAKE_ASK_WAIT_MS: '300' } });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /parked/);
    let detail = await jobOf(job.id);
    assert.equal(detail.job.state, 'needs-input');
    const session = detail.job.sessionId;
    const q = detail.questions[0];
    assert.ok(q.parkedAt);

    res = await runner({ env: { FAKE_CLAUDE_SCENARIO: 'ask' } });
    assert.match(res.text, /Ran 0 jobs/, 'unanswered: nothing to resume');

    await ann.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { text: 'green' } } });
    res = await runner({ env: { FAKE_CLAUDE_SCENARIO: 'ask' } });
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /resuming/);
    const before = detail.events.length;
    detail = await jobOf(job.id);
    assert.equal(detail.job.state, 'done');
    assert.equal(detail.job.sessionId, session, 'the same session continues');
    assert.ok(detail.events.length > before, 'the resumed session\'s events are kept, numbered after the parked ones');
    assert.equal(detail.lastSeq, detail.events.at(-1).seq);
    assert.match(detail.job.result.result, /resumed with: .*Which colour\?.*Answer: green/s, 'the answer is quoted in the resume prompt');
  });

  test('a permission the mode would ask for is decided on the page', async () => {
    const job = await request('batch-5');
    const running = runner({ env: { FAKE_CLAUDE_SCENARIO: 'permission' } });
    const q = await until(async () => (await jobOf(job.id)).questions.find((x) => !x.answeredAt));
    assert.equal(q.kind, 'permission');
    assert.equal(q.question.tool, 'Bash');
    await ann.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { decision: 'deny' } } });
    await running;
    assert.equal((await jobOf(job.id)).job.result.result, 'decision: deny');
  });

  test('a session that fails is a failed job with the reason', async () => {
    const job = await request('batch-6');
    await runner({ env: { FAKE_CLAUDE_SCENARIO: 'fail' } });
    const detail = await jobOf(job.id);
    assert.equal(detail.job.state, 'failed');
    assert.match(detail.job.error, /boom/);
  });

  test('a session that ran into the usage window pauses the machine', async () => {
    const job = await request('batch-1');
    const res = await runner({ env: { FAKE_CLAUDE_SCENARIO: 'limit' } });
    assert.match(res.text, /pausing until/);
    assert.equal((await jobOf(job.id)).job.state, 'failed');
    const { machines } = await (await ann.get(api('machines'))).json();
    assert.ok(machines[0].pausedUntil);
    assert.equal(machines[0].usage.rateLimits[0].percentUsed, 97);
    const next = await runner();
    assert.match(next.text, /paused until/);
  });
});
