// The job queue over HTTP: a page asks, only the asker's own runner may take and
// report, questions go out to the page and the answers come back, parked jobs resume.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { profile, startHosted } from './helpers/hosted.mjs';

const BIG = 'x'.repeat(20_000);

describe('the job queue', () => {
  let h; let ann; let bob; let annToken; let bobToken; let machine;
  const api = (path) => `/api/p/harbor/${path}`;
  const asToken = (token, path, { method = 'POST', json } = {}) => fetch(new URL(api(path), h.origin), { method, headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const runner = (path, json, extra = {}) => asToken(annToken, path, extra.method === 'GET' ? extra : { json: { machineId: machine, ...json }, ...extra });
  const mint = async (browser) => /tfp_[A-Za-z0-9_-]+/.exec(await (await browser.post('/settings/tokens', { form: { label: 'laptop' } })).text())[0];

  before(async () => {
    h = await startHosted({ admins: ['ann'] });
    ann = h.browser(); await ann.signIn(profile('ann'));
    await ann.post('/settings/projects', { form: { id: 'harbor', name: 'Harbor Books' } });
    await ann.post('/settings/members/invite', { form: { project: 'harbor', login: 'bob', role: 'developer' } });
    bob = h.browser(); await bob.signIn(profile('bob'));
    annToken = await mint(ann);
    bobToken = await mint(bob);
  });
  after(async () => { await h.close().catch(() => {}); });

  test('a page requests a job; a token, a stranger and a bad kind cannot', async () => {
    let res = await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-2' } } });
    assert.equal(res.status, 200);
    const { job } = await res.json();
    assert.equal(job.state, 'queued');
    assert.equal(job.kind, 'implement');
    assert.deepEqual(job.args, { batchKey: 'batch-2' });
    assert.equal(job.requestedByLogin, 'ann');

    res = await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-2' } } });
    assert.equal(res.status, 409, 'the same job twice is refused while the first is open');
    res = await ann.post(api('jobs'), { json: { kind: 'deploy', args: {} } });
    assert.equal(res.status, 400);
    res = await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: '../x' } } });
    assert.equal(res.status, 400);
    res = await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-3' } }, origin: false });
    assert.equal(res.status, 403, 'a session must show where it calls from');
    res = await asToken(annToken, 'jobs', { json: { kind: 'implement', args: { batchKey: 'batch-3' } } });
    assert.equal(res.status, 403, 'a token has no page to click Start on');
    await ann.post('/settings/projects', { form: { id: 'other', name: 'Other' } });
    await ann.post('/settings/members/invite', { form: { project: 'other', login: 'cara', role: 'developer' } });
    const cara = h.browser(); await cara.signIn(profile('cara'));
    res = await cara.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-3' } } });
    assert.equal(res.status, 404, 'a developer of another project does not learn this one exists');

    const list = await (await ann.get(api('jobs'))).json();
    assert.equal(list.jobs.length, 1);
    assert.ok(list.rev >= 1);
  });

  test('a runner registers a machine with a token, never with a session', async () => {
    let res = await ann.post(api('machines'), { json: { name: 'laptop', kinds: ['implement'] } });
    assert.equal(res.status, 403);
    res = await asToken(annToken, 'machines', { json: { name: 'laptop', kinds: ['implement', 'bogus kind'], concurrency: 1, runnerVersion: '1.7.0' } });
    assert.equal(res.status, 200);
    const got = (await res.json()).machine;
    machine = got.id;
    assert.deepEqual(got.kinds, ['implement'], 'an unknown kind name is dropped');
    assert.equal(got.online, true);
    res = await asToken(annToken, 'machines', { json: { id: machine, name: 'laptop 2', kinds: ['implement'] } });
    assert.equal((await res.json()).machine.name, 'laptop 2', 'the same id registers again as an update');
    res = await asToken(bobToken, 'machines', { json: { id: machine, name: 'mine now', kinds: ['implement'] } });
    assert.equal(res.status, 404, "another user cannot claim a machine id");
    const list = await (await ann.get(api('machines'))).json();
    assert.equal(list.machines.length, 1);
  });

  test("only the asker's own machine takes the job, and only for a kind it runs", async () => {
    const bobMachine = (await (await asToken(bobToken, 'machines', { json: { name: 'bob-box', kinds: ['implement'] } })).json()).machine.id;
    let leased = await (await asToken(bobToken, 'jobs/next', { json: { machineId: bobMachine, kinds: ['implement'], wait: 0 } })).json();
    assert.equal(leased.job, null, "bob's runner does not get ann's job");
    leased = await (await runner('jobs/next', { kinds: ['triage'], wait: 0 })).json();
    assert.equal(leased.job, null, 'a runner that only runs triage gets nothing');
    let res = await asToken(annToken, 'jobs/next', { json: { machineId: bobMachine, kinds: ['implement'], wait: 0 } });
    assert.equal(res.status, 404, "ann's token with bob's machine id is refused");

    leased = await (await runner('jobs/next', { kinds: ['implement'], wait: 0 })).json();
    assert.equal(leased.job.state, 'running');
    assert.equal(leased.job.machineId, machine);
    assert.equal(leased.resume, false);
    const again = await (await runner('jobs/next', { kinds: ['implement'], wait: 0 })).json();
    assert.equal(again.job, null);
    assert.equal(again.busy, true, 'concurrency 1: nothing more while one runs');
  });

  test('events are stored compacted and deduplicated; the page reads the tail', async () => {
    const { jobs } = await (await ann.get(api('jobs'))).json();
    const job = jobs[0];
    const events = [
      { seq: 1, event: { type: 'system', subtype: 'init', model: 'claude-x', permissionMode: 'auto', session_id: job.id, tools: ['Bash'], plugins: [{ name: 'taskflow' }] } },
      { seq: 2, event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the plan' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: BIG } }] } } },
      { seq: 3, event: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: BIG }] } } },
      { seq: 4, event: { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1 } } } } },
    ];
    let res = await runner(`jobs/${job.id}/events`, { events });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stored, 4);
    res = await runner(`jobs/${job.id}/events`, { events: events.slice(0, 2) });
    assert.equal((await res.json()).stored, 0, 'a retried post stores nothing twice');
    res = await asToken(bobToken, `jobs/${job.id}/events`, { json: { machineId: machine, events } });
    assert.equal(res.status, 404, "bob's token cannot write to ann's job");

    const detail = await (await ann.get(api(`jobs/${job.id}`))).json();
    assert.equal(detail.events.length, 4);
    assert.equal(detail.events[0].plugins[0], 'taskflow');
    assert.ok(detail.events[1].content[1].input.length < 1200, 'a huge tool input is clipped');
    assert.ok(detail.events[2].content[0].content.length < 1200, 'a huge tool result is clipped');
    const tail = await (await ann.get(api(`jobs/${job.id}?after=3`))).json();
    assert.deepEqual(tail.events.map((e) => e.seq), [4]);
  });

  test('a question goes to the page, the answer comes back to the waiting session', async () => {
    const job = (await (await ann.get(api('jobs'))).json()).jobs[0];
    let res = await runner(`jobs/${job.id}/questions`, { kind: 'ask', question: { text: 'Which colour?', options: ['red', 'blue'] } });
    assert.equal(res.status, 200);
    const q = (await res.json()).question;
    assert.equal(q.kind, 'ask');
    assert.deepEqual(q.question, { text: 'Which colour?', options: ['red', 'blue'] });

    res = await runner(`jobs/${job.id}/questions/${q.id}?wait=300`, {}, { method: 'GET' });
    let got = await res.json();
    assert.equal(got.answered, false, 'the wait ran out, nobody answered');

    const detail = await (await ann.get(api(`jobs/${job.id}`))).json();
    assert.equal(detail.job.openQuestions, 1);
    res = await ann.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { text: '' } } });
    assert.equal(res.status, 400);
    res = await asToken(annToken, `jobs/${job.id}/questions/${q.id}/answer`, { json: { answer: { text: 'blue' } } });
    assert.equal(res.status, 403, 'a token never records what a person said');
    res = await bob.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { text: 'blue, says bob' } } });
    assert.equal(res.status, 200, 'a developer teammate may answer');
    res = await ann.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { text: 'red' } } });
    assert.equal(res.status, 409, 'answered once');

    got = await (await runner(`jobs/${job.id}/questions/${q.id}?wait=0`, {}, { method: 'GET' })).json();
    assert.equal(got.answered, true);
    assert.equal(got.question.answer.text, 'blue, says bob');
    assert.ok(got.question.answeredBy);
  });

  test('a permission question is answered allow or deny', async () => {
    const job = (await (await ann.get(api('jobs'))).json()).jobs[0];
    const q = (await (await runner(`jobs/${job.id}/questions`, { kind: 'permission', question: { tool: 'Bash', input: { command: 'git push --force' }, reason: 'This command requires approval' } })).json()).question;
    assert.equal(q.question.tool, 'Bash');
    let res = await ann.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { decision: 'maybe' } } });
    assert.equal(res.status, 400);
    res = await ann.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { decision: 'deny', note: 'not from here' } } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).question.answer, { decision: 'deny', note: 'not from here' });
  });

  test('a parked job resumes on the same machine once its question is answered', async () => {
    const job = (await (await ann.get(api('jobs'))).json()).jobs[0];
    const q = (await (await runner(`jobs/${job.id}/questions`, { kind: 'ask', question: { text: 'Still there?' } })).json()).question;
    let res = await runner(`jobs/${job.id}/questions/${q.id}/park`, {});
    assert.equal(res.status, 200);
    assert.equal((await (await ann.get(api(`jobs/${job.id}`))).json()).job.state, 'needs-input');
    let leased = await (await runner('jobs/next', { kinds: ['implement'], wait: 0 })).json();
    assert.equal(leased.job, null, 'unanswered: nothing to resume');
    res = await ann.post(api(`jobs/${job.id}/questions/${q.id}/answer`), { json: { answer: { text: 'yes' } } });
    assert.equal(res.status, 200, await res.text());
    leased = await (await runner('jobs/next', { kinds: ['implement'], wait: 0 })).json();
    assert.ok(leased.job, JSON.stringify(leased));
    assert.equal(leased.job.id, job.id);
    assert.equal(leased.resume, true);
    assert.equal(leased.answers.length, 1);
    assert.equal(leased.answers[0].answer.text, 'yes');
    assert.equal(leased.job.state, 'running');
  });

  test('the runner reports the end; a finished job is final; a queued one can be cancelled', async () => {
    const job = (await (await ann.get(api('jobs'))).json()).jobs[0];
    let res = await runner(`jobs/${job.id}/state`, { state: 'done', sessionId: job.id, result: { type: 'result', subtype: 'success', num_turns: 7, duration_ms: 1234, total_cost_usd: 0.5, result: 'Opened PR #12', permission_denials: [], usage: { input_tokens: 1, output_tokens: 2 } } });
    assert.equal(res.status, 200);
    const ended = (await res.json()).job;
    assert.equal(ended.state, 'done');
    assert.equal(ended.result.total_cost_usd, 0.5);
    assert.equal(ended.result.result, 'Opened PR #12');
    assert.ok(ended.finishedAt);
    res = await runner(`jobs/${job.id}/state`, { state: 'running' });
    assert.equal(res.status, 409, 'done is final');
    res = await runner(`jobs/${job.id}/questions`, { kind: 'ask', question: { text: 'late' } });
    assert.equal(res.status, 409, 'a finished job cannot ask');

    const next = (await (await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-9' } } })).json()).job;
    res = await ann.post(api(`jobs/${next.id}/cancel`), { json: {} });
    assert.equal((await res.json()).job.state, 'cancelled');
    res = await ann.post(api(`jobs/${next.id}/cancel`), { json: {} });
    assert.equal(res.status, 409);
  });

  test('a queued job nobody took in time expires when the queue is read', async () => {
    const stale = (await (await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-5' } } })).json()).job;
    await h.db.query("update job set expires_at = now() - interval '1 minute' where id = $1", [stale.id]);
    const { jobs } = await (await ann.get(api('jobs'))).json();
    assert.equal(jobs.find((j) => j.id === stale.id).state, 'expired');
    const leased = await (await runner('jobs/next', { kinds: ['implement'], wait: 0 })).json();
    assert.equal(leased.job, null);
  });

  test('a usage report pauses the machine and the lease says so', async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    let res = await runner(`machines/${machine}/usage`, { usage: { unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: 123 } } }, pausedUntil: until });
    assert.equal(res.status, 200);
    const m = (await res.json()).machine;
    assert.equal(m.usage.rateLimits[0].percentUsed, 97);
    await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-6' } } });
    const leased = await (await runner('jobs/next', { kinds: ['implement'], wait: 0 })).json();
    assert.equal(leased.job, null);
    assert.ok(leased.pausedUntil);
    res = await runner(`machines/${machine}/usage`, { pausedUntil: null });
    assert.equal((await res.json()).machine.pausedUntil, null);
  });

  test('an open page hears about a job over SSE without a model rebuild', async () => {
    const controller = new AbortController();
    const cookie = [...ann.jar].map(([name, c]) => `${name}=${c.value}`).join('; ');
    const stream = await fetch(new URL('/p/harbor/u/ann/api/events', h.origin), { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const chunks = [];
    const seen = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        chunks.push(decoder.decode(value));
        if (chunks.join('').includes('event: jobs')) return;
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    await ann.post(api('jobs'), { json: { kind: 'implement', args: { batchKey: 'batch-7' } } });
    await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('no jobs event within 3 s')), 3000))]);
    assert.match(chunks.join(''), /event: jobs\ndata: \{"rev":"?\d+"?\}/);
    controller.abort();
  });
});
