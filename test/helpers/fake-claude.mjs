#!/usr/bin/env node
// A stand-in for the `claude` binary, for the runner's tests: prints the stream-json a headless
// session prints, and, where a real session's mod would, asks the server a question and waits.
// Driven by FAKE_CLAUDE_SCENARIO: ok | ask | permission | fail | limit. A `--resume` run reports
// the prompt it was resumed with.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const sessionId = value('--session-id') ?? value('--resume');
const resume = argv.includes('--resume');
const prompt = argv.at(-1);
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'ok';
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const jobId = process.env.TASKFLOW_JOB_ID;
const server = process.env.TASKFLOW_JOB_SERVER;
const project = process.env.TASKFLOW_JOB_PROJECT;
const machineId = process.env.TASKFLOW_MACHINE_ID;
const token = process.env.TASKFLOW_TOKEN || (() => {
  try { return JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME, 'taskflow', 'credentials.json'), 'utf8'))[server]?.token ?? null; } catch { return null; }
})();
const api = async (method, path, body) => {
  const res = await fetch(`${server}/api/p/${project}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${parsed.error ?? ''}`);
  return parsed;
};
async function askAndWait(kind, question, limitMs) {
  const { question: q } = await api('POST', `/jobs/${jobId}/questions`, { machineId, kind, question });
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const got = await api('GET', `/jobs/${jobId}/questions/${q.id}?wait=1`);
    if (got.answered) return got.question.answer;
  }
  if (kind === 'ask') await api('POST', `/jobs/${jobId}/questions/${q.id}/park`, { machineId });
  return null;
}
const result = (extra) => out({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 1234, duration_api_ms: 900, total_cost_usd: 0.42, session_id: sessionId, stop_reason: 'end_turn', permission_denials: [], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, result: 'done', ...extra });

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake', permissionMode: value('--permission-mode'), tools: ['Bash'], plugins: [{ name: 'taskflow' }], cwd: process.cwd() });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: resume ? `resumed with: ${prompt}` : `prompt: ${prompt}` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }] } });
out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi', is_error: false }] } });
const util = Number(process.env.FAKE_UTIL ?? (scenario === 'limit' ? 0.97 : 0.3));
out({ type: 'rate_limit_event', rate_limit_info: { status: util >= 0.95 ? 'rejected' : 'allowed', unifiedWindows: { five_hour: { utilization: util, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });

if (resume) { result({ result: `resumed with: ${prompt}` }); process.exit(0); }
if (scenario === 'ask') {
  const answer = await askAndWait('ask', { text: 'Which colour?', options: ['red', 'blue'] }, Number(process.env.FAKE_ASK_WAIT_MS ?? 10_000));
  result({ result: answer ? `Answer was: ${answer.text}` : 'parked' });
} else if (scenario === 'permission') {
  const answer = await askAndWait('permission', { tool: 'Bash', input: { command: 'git push --force' }, reason: 'This command requires approval' }, Number(process.env.FAKE_ASK_WAIT_MS ?? 10_000));
  result({ result: `decision: ${answer?.decision ?? 'none'}` });
} else if (scenario === 'fail') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 10, total_cost_usd: 0.01, session_id: sessionId, result: 'boom: the build broke twice', permission_denials: [] });
} else if (scenario === 'limit') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 10, total_cost_usd: 0, session_id: sessionId, result: "You've hit your usage limit", permission_denials: [] });
} else {
  result({ result: 'Opened PR #1' });
}
