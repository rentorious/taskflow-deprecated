// The job vocabulary: what may be asked of a machine, and how a session's events are
// cut down before they travel. Compaction is applied twice (runner, then server), so
// it must be a fixed point.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JOB_KINDS, KINDS, compactEvent, compactResult, compactUsage, describeJob, validateJob } from '../scripts/report/jobs.mjs';

test('a job is a known kind with validated args; the prompt is built from them alone', () => {
  assert.deepEqual(JOB_KINDS, ['implement', 'triage']);
  assert.deepEqual(validateJob('implement', { batchKey: 'batch-2', extra: 'ignored' }), { kind: 'implement', args: { batchKey: 'batch-2' } });
  assert.equal(KINDS.implement.prompt({ batchKey: 'batch-2' }), '/taskflow:implement batch-2');
  assert.equal(describeJob({ kind: 'implement', args: { batchKey: 'batch-2' } }), 'implement batch-2');
  for (const bad of [['deploy', {}], ['implement', {}], ['implement', { batchKey: '../etc' }], ['implement', { batchKey: 'a b' }]]) {
    assert.throws(() => validateJob(...bad), (error) => error.status === 400);
  }
  assert.deepEqual(validateJob('triage', { list: 'ignored: the skill reads the config' }), { kind: 'triage', args: {} });
  assert.deepEqual(validateJob('triage'), { kind: 'triage', args: {} });
  assert.equal(KINDS.triage.prompt({}), '/taskflow:triage');
  assert.equal(describeJob({ kind: 'triage', args: {} }), 'triage');
  assert.equal(KINDS.triage.permissionMode, 'acceptEdits');
  assert.ok(KINDS.triage.ttlMs > KINDS.implement.ttlMs, 'a triage may wait longer for a machine to come online');
});

test('events are cut to what the pane shows, and cutting twice changes nothing', () => {
  const big = 'y'.repeat(50_000);
  const raw = [
    { type: 'system', subtype: 'init', model: 'm', permissionMode: 'auto', session_id: 's', tools: ['Bash'], plugins: [{ name: 'taskflow' }, 'other'], mcp_servers: [] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: big }, { type: 'text', text: 'hello' }, { type: 'tool_use', id: 't', name: 'Read', input: { file_path: big } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: big, is_error: true }] } },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 } } } },
    { type: 'stream_event', event: { delta: big } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 5, total_cost_usd: 0.1, result: big, permission_denials: [{ tool_name: 'Bash', tool_input: { command: big } }], usage: { input_tokens: 1, output_tokens: 2 } },
  ];
  const once = raw.map(compactEvent);
  const twice = once.map(compactEvent);
  assert.deepEqual(twice, once);
  assert.deepEqual(once[0].plugins, ['taskflow', 'other']);
  assert.equal(once[1].content.length, 3);
  assert.deepEqual(once[1].content[0], { type: 'thinking' }, 'thinking text never travels');
  assert.ok(once[1].content[2].input.length <= 1001);
  assert.ok(once[2].content[0].content.length <= 1001);
  assert.equal(once[2].content[0].is_error, true);
  assert.deepEqual(once[4], { type: 'stream_event' });
  assert.ok(once[5].result.length <= 2001);
  assert.ok(once[5].permission_denials[0].input.length <= 301);
  assert.equal(once[5].total_cost_usd, 0.1);
  for (const event of once) assert.ok(JSON.stringify(event).length < 8000);
  assert.equal(compactEvent({ type: 'assistant', message: { content: [] } }), null, 'an empty message is dropped');
  assert.equal(compactEvent('junk'), null);
  assert.deepEqual(compactResult(raw[5]).usage, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined });
});

test('a usage reading has one shape whether it came from the event stream or the mods API', () => {
  const fromEvent = compactUsage({ unifiedWindows: { five_hour: { utilization: 0.31, resetsAt: 10 }, seven_day: { utilization: 0.05, resetsAt: 20 } } });
  const fromMod = compactUsage({ rateLimits: [{ kind: 'five_hour', percentUsed: 31, resetsAt: 10 }, { kind: 'seven_day', percentUsed: 5, resetsAt: 20 }] });
  assert.deepEqual(fromEvent.rateLimits, fromMod.rateLimits);
  assert.equal(compactUsage(null), null);
});
