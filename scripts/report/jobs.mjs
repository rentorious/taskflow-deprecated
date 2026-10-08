// What the dashboard may ask a developer's machine to do, and nothing else.
//
// A job is a KIND from this closed vocabulary plus validated ARGS. The server stores
// and queues it; the runner on the developer's machine turns it into a claude
// invocation here, from the kind and args alone. Prompt text never travels: a
// compromised server can only name things this file already knows how to run.

import { SAFE_NAME } from './read.mjs';

export const JOB_STATES = Object.freeze(['queued', 'running', 'needs-input', 'done', 'failed', 'refused', 'expired', 'cancelled']);
export const OPEN_STATES = Object.freeze(['queued', 'running', 'needs-input']);
export const QUESTION_KINDS = Object.freeze(['ask', 'permission']);

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * kind -> { args(input) -> validated args or throws, prompt(args) -> the slash command the
 * session starts with, ttlMs, permissionMode, describe(args) -> a short label }
 */
export const KINDS = Object.freeze({
  implement: {
    args(input) {
      const batchKey = String(input?.batchKey ?? '');
      if (!SAFE_NAME.test(batchKey)) throw new Error(`implement needs a batch key, got: ${batchKey || '(none)'}`);
      return { batchKey };
    },
    prompt: (args) => `/taskflow:implement ${args.batchKey}`,
    describe: (args) => `implement ${args.batchKey}`,
    ttlMs: DEFAULT_TTL_MS,
    // acceptEdits, not auto: verified 2026-10-08 that `--permission-mode auto` under -p behaves as default here
    // (a plain `ls` is denied), while acceptEdits plus the project's own allow rules runs everyday pnpm/git/node
    // work and sends only the rest to the phone through the mod.
    permissionMode: 'acceptEdits',
  },
  triage: {
    // No args: the skill reads the lists to triage from the project's own config. The server keeps
    // one open job per (kind, args), so a second Triage while one is open is refused, not queued twice.
    args: () => ({}),
    prompt: () => '/taskflow:triage',
    describe: () => 'triage',
    // Asked for when a sprint starts, not when a machine happens to be on: it may wait an hour for one.
    ttlMs: 60 * 60 * 1000,
    permissionMode: 'acceptEdits',
  },
});

export const JOB_KINDS = Object.freeze(Object.keys(KINDS));

/** @returns {{kind: string, args: object}} or throws an Error with `.status = 400` */
export function validateJob(kind, args) {
  const spec = KINDS[kind];
  if (!spec) throw Object.assign(new Error(`Unknown job kind: ${kind}. Known: ${JOB_KINDS.join(', ')}`), { status: 400 });
  try {
    return { kind, args: spec.args(args ?? {}) };
  } catch (error) {
    throw Object.assign(new Error(error.message), { status: 400 });
  }
}

export const describeJob = (job) => (KINDS[job.kind]?.describe ?? (() => job.kind))(job.args ?? {});

// -- the event stream, compacted ---------------------------------------------------
//
// A session's stream-json events are forwarded to the server so the page can tail them.
// Most of each event is bulk the page never shows (full tool inputs, whole file
// contents in results). Keep what the pane renders, cap every string, and keep the
// final result's numbers whole. Applied by the runner before sending and by the
// server before storing, so neither trusts the other to have done it.

const TEXT_MAX = 2000;
const INPUT_MAX = 1000;
const EVENT_MAX = 8000;

const clip = (value, max) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function compactBlock(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'text') return { type: 'text', text: clip(block.text, TEXT_MAX) };
  if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: clip(block.input ?? {}, INPUT_MAX) };
  if (block.type === 'tool_result') return { type: 'tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error === true, content: clip(block.content ?? '', INPUT_MAX) };
  if (block.type === 'thinking') return { type: 'thinking' };
  return { type: String(block.type ?? 'unknown') };
}

/** @returns {object} a compact event, or null for one the page has no use for */
export function compactEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type ?? '');
  let out;
  if (type === 'assistant' || type === 'user') {
    // Raw (message.content) or already compacted (content): compacting twice must give the same event.
    const blocks = Array.isArray(event.message?.content) ? event.message.content : Array.isArray(event.content) ? event.content : [];
    const content = blocks.map(compactBlock).filter(Boolean);
    if (content.length === 0) return null;
    out = { type, content, ...(event.parent_tool_use_id ? { parent_tool_use_id: event.parent_tool_use_id } : {}) };
  } else if (type === 'system') {
    out = { type, subtype: event.subtype };
    if (event.subtype === 'init') Object.assign(out, { model: event.model, permissionMode: event.permissionMode, session_id: event.session_id, plugins: (event.plugins ?? []).map((p) => (p && typeof p === 'object' ? p.name : p)).filter(Boolean).slice(0, 20) });
  } else if (type === 'result') {
    out = compactResult(event);
  } else if (type === 'rate_limit_event') {
    out = { type, rate_limit_info: event.rate_limit_info ?? null };
  } else {
    out = { type };
  }
  if (JSON.stringify(out).length > EVENT_MAX) out = { type, truncated: true };
  return out;
}

/** The final event, with every number the job row keeps and the text clipped. */
export function compactResult(event) {
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
  return {
    type: 'result',
    subtype: event.subtype,
    is_error: event.is_error === true,
    num_turns: event.num_turns ?? null,
    duration_ms: event.duration_ms ?? null,
    duration_api_ms: event.duration_api_ms ?? null,
    total_cost_usd: event.total_cost_usd ?? null,
    stop_reason: event.stop_reason ?? null,
    terminal_reason: event.terminal_reason ?? null,
    session_id: event.session_id ?? null,
    permission_denials: denials.slice(0, 50).map((d) => ({ tool_name: d.tool_name, input: clip(d.tool_input ?? d.input ?? {}, 300) })),
    usage: event.usage ? { input_tokens: event.usage.input_tokens, output_tokens: event.usage.output_tokens, cache_read_input_tokens: event.usage.cache_read_input_tokens, cache_creation_input_tokens: event.usage.cache_creation_input_tokens } : null,
    result: clip(event.result ?? '', TEXT_MAX),
  };
}

/** What a session's rate_limit_event or $.session.usage() says, in one shape the machine row stores. */
export function compactUsage(info) {
  if (!info || typeof info !== 'object') return null;
  const windows = info.unifiedWindows ?? {};
  const list = Array.isArray(info.rateLimits) ? info.rateLimits : Object.entries(windows).map(([kind, w]) => ({ kind, percentUsed: Math.round((w?.utilization ?? 0) * 100), resetsAt: w?.resetsAt ?? null }));
  return { at: Date.now(), rateLimits: list.slice(0, 4).map((r) => ({ kind: String(r.kind), percentUsed: Number(r.percentUsed) || 0, resetsAt: r.resetsAt ?? null })) };
}
