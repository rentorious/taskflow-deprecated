// The taskflow mod: how a headless session, started by the runner, reaches the person.
//
// Inert in every ordinary session. When the runner started this session it set
// TASKFLOW_JOB_ID (and the server, project and machine), and then:
//   - `mcp__taskflow__ask` exists: the skills call it where they would ask a human.
//     The question goes to the dashboard; the call waits here, polling, until the
//     answer arrives, and returns it as the tool's result. No answer in time: the
//     job is parked, the session is told to stop, and the runner resumes it later.
//   - a permission the mode would have ASKED for goes to the dashboard the same way
//     (allow / deny), so no session runs with permissions bypassed.
//   - after each turn, how much of the plan's window is used is reported.
// Headless claude has no AskUserQuestion and denies every "ask" silently; this is
// what gives the person back their say.

const ASK_WAIT_MS = 15 * 60 * 1000;
const PERMISSION_WAIT_MS = 15 * 60 * 1000;
const POLL_S = 25; // under $.http.fetch's own 30 s cap; the server holds the request that long

let job = null; // { id, server, project, machineId, token }

const base = () => `${job.server}/api/p/${job.project}`;

// Every $.env.get is a mods API call, so it resolves asynchronously: always awaited.
async function readToken($, server) {
  const fromEnv = await $.env.get('TASKFLOW_TOKEN');
  if (fromEnv) return fromEnv;
  const xdg = await $.env.get('XDG_CONFIG_HOME');
  const home = await $.env.get('HOME');
  const path = `${xdg || `${home}/.config`}/taskflow/credentials.json`;
  const all = JSON.parse(await $.fs.read(path));
  return all[server]?.token ?? null;
}

async function api($, method, path, body) {
  const res = await $.http.fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${job.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = {};
  try { parsed = JSON.parse(res.text); } catch { /* an empty or non-JSON body */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}${parsed.error ? `: ${parsed.error}` : ''}`);
  return parsed;
}

/** Poll until the question is answered or `limitMs` passes. Each poll is one mods API call, so the wait is not counted against the hook. */
async function waitFor($, questionId, limitMs) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const got = await api($, 'GET', `/jobs/${job.id}/questions/${questionId}?wait=${POLL_S}`);
    if (got.answered) return got.question.answer;
  }
  return null;
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const id = await $.env.get('TASKFLOW_JOB_ID');
    if (!id) return next(e);
    const server = await $.env.get('TASKFLOW_JOB_SERVER');
    const project = await $.env.get('TASKFLOW_JOB_PROJECT');
    const machineId = (await $.env.get('TASKFLOW_MACHINE_ID')) || null;
    if (!server || !project) return next(e);
    let token = null;
    try { token = await readToken($, server); } catch { /* no credentials: the tool will say so */ }
    job = { id, server, project, machineId, token };
    await $.tool.register({
      name: 'ask',
      description: 'Ask the developer a question and wait for the answer. Use it wherever you would otherwise stop to ask a human: a decision the plan leaves open, a failing build you cannot fix, a choice between approaches. Returns the developer\'s answer. If no answer arrives in time the job is parked and you must stop.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, with the context the developer needs to answer it from a phone.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Up to 8 short choices, when the question is a choice.' },
        },
        required: ['question'],
      },
      isDeferred: false,
    });
    return next(e);
  });

  on('tool.call', { tool: 'mcp__taskflow__ask' }, async ($, e) => {
    if (!job?.token) return { result: 'Not running as a taskflow job with a token: nobody can be asked this way. Decide with the information you have, or stop and say what you needed to know.' };
    const asked = await api($, 'POST', `/jobs/${job.id}/questions`, { machineId: job.machineId, kind: 'ask', question: { text: e.question, options: Array.isArray(e.options) ? e.options : [] } });
    return finishAsk($, asked);
  }).catch(async () => ({ result: 'The question could not be delivered to the dashboard. Stop here, end your turn, and say in one line what you needed to know.' }));

  on('tool.check', async ($, e, next) => {
    const decided = await next(e);
    if (!job?.token || decided?.decision !== 'ask') return decided;
    const asked = await api($, 'POST', `/jobs/${job.id}/questions`, { machineId: job.machineId, kind: 'permission', question: { tool: e.tool, input: e.input, reason: decided.reason ?? '' } });
    const answer = await waitFor($, asked.question.id, PERMISSION_WAIT_MS);
    if (!answer) return { decision: 'deny', reason: 'Nobody answered the permission question in the dashboard in time. Find another way, or stop and say what you needed.' };
    if (answer.decision === 'allow') return { decision: 'allow' };
    return { decision: 'deny', reason: `The developer refused this in the dashboard${answer.note ? `: ${answer.note}` : '.'}` };
  }).catch(async () => ({ decision: 'deny', reason: 'The permission question could not be delivered to the dashboard.' }));

  on('turn.complete', async ($, e, next) => {
    if (job?.token && job.machineId) {
      try {
        const usage = await $.session.usage();
        if (usage?.rateLimits?.length) await api($, 'POST', `/machines/${job.machineId}/usage`, { usage: { rateLimits: usage.rateLimits } });
      } catch { /* a missed reading; the runner reports the session's own rate_limit_event too */ }
    }
    return next(e);
  });
}

async function finishAsk($, asked) {
  const answer = await waitFor($, asked.question.id, ASK_WAIT_MS);
  if (answer) return { result: `The developer answered: ${answer.text}` };
  await api($, 'POST', `/jobs/${job.id}/questions/${asked.question.id}/park`, { machineId: job.machineId });
  return { result: 'No answer arrived in time. This job is now PARKED: stop working, change nothing further, and end your turn with one line saying where you stopped. The session will be resumed with the answer.' };
}
