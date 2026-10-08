// The runner as a child process against a hosted app, with a stand-in `claude`: it
// registers its machine, takes only what the page queued for this developer, launches
// the right command, forwards the events, relays a question and its answer, parks a
// job nobody answered and resumes it, and reports failures and usage.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const NOW = Date.UTC(2026, 1, 4, 12, 0, 0);

function run(args, { cwd, home, env = {}, stdin = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, XDG_CONFIG_HOME: home, TASKFLOW_TOKEN: '', TASKFLOW_POLL_WAIT_S: '1', TASKFLOW_CLAUDE: FAKE, ...env } });
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
    assert.equal(detail.events[0].permissionMode, 'auto', 'auto mode, never bypass');
    assert.ok(detail.events[1].content, JSON.stringify(detail.events.map((e) => [e.seq, e.type, e.subtype])));
    assert.match(detail.events[1].content[0].text, /^prompt: \/taskflow:implement batch-2$/, 'the prompt is built here, from the kind and args');
    assert.equal(detail.events.at(-1).type, 'result');
    const { machines } = await (await ann.get(api('machines'))).json();
    assert.equal(machines[0].usage.rateLimits[0].percentUsed, 30);
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
    detail = await jobOf(job.id);
    assert.equal(detail.job.state, 'done');
    assert.equal(detail.job.sessionId, session, 'the same session continues');
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
