# Hosted dashboard with answers and an implement gate — design

Status: Phase 0 implemented in 1.5.0 (2026-09-18); Phase 1 live since 2026-09-29 (1.6.0 + Railway); the plan from Phase 2 on was re-cut on 2026-10-08, see "Amendments B". Builds on `2026-09-17-report-rework-design.md` (1.4.0).

## Goal

1. The dashboard runs on Railway, not only on the developer's machine.
2. The developer types answers (gathered from clients and colleagues) into the dashboard.
3. `/taskflow:implement` reads those answers, and refuses to start a batch whose blocking
   questions are not fully answered.
4. The provider rule stands: the only ClickUp write taskflow makes is a task status change.
   Answers live in taskflow's own database and are never written back to the provider.
5. Several people can use one deployment: developers with their own cycles, and colleagues who only answer.
6. The dashboard is used from a phone as often as from a desk. Mobile is a first-class layout, not a fallback.

## Findings that shape the plan

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | There is nothing structured to gate on today | The live index has 0 `needs[]` and no `schema_version` (rebuilt from an archive). 4 of 24 plan files carry a prose `## Open Question` | Structured questions come first, before any hosting |
| F2 | Schema v2 writes ONE question per task, with the fixed key `question` | `skills/triage/SKILL.md` Step 7a | "Answered fully" cannot be checked on a blob of several questions. One need per question |
| F3 | implement has no question gate | Step 2 only prompts interactively on `confidence: low`. It never reads `needs[]` or ticks | The gate is new behaviour, not a port |
| F4 | A prose gate is not reliable | triage Step 4 wrote ClickUp descriptions although the config said no comments | The gate is a script with an exit code, not a paragraph in a skill |
| F5 | The report's whole security model is "loopback only" | `server.mjs`: binds 127.0.0.1, Host allowlist, no auth | Going public makes auth the main new work, more than the database |
| F6 | The report already has the right seam | `model.mjs` is pure `(RawCycle, ticks, enrichment, now) -> view model`; only `read.mjs` and `ticks.mjs` touch disk | The server swaps two adapters and reuses model, inbox, markdown, estimates, snapshot and the UI unchanged |
| F7 | `enrich.mjs` shells out to `gh` and `git` | `gh pr view`, `git worktree list` | Neither exists on Railway. PR state and worktrees are collected on the laptop and travel in the pushed snapshot (D19) |
| F8 | Railway's "root directory" setting only pulls files from that directory | Railway monorepo guide | A `server/` root could not import `scripts/report/*.mjs`. Deploy from the repository root |
| F9 | Railway closes an HTTP request at 15 minutes even with heartbeats, 5 minutes without data | Railway public networking limits | SSE streams get cut. The client already reconnects (`retry: 3000`) and falls back to polling; no change needed |
| F10 | Ticks die with their cycle | Known limit in the 1.4.0 spec; 23 plans were carried from 09-17 into 09-18 | Human state is keyed by task, not by cycle |
| F11 | A server may never hold or use anyone's Claude login. A user running the unmodified `claude` binary under their own subscription is explicitly fine | Claude Code "Legal and compliance", *Authentication and credential use*: developers "may not collect, store, or intermediate Claude.ai credentials or session tokens"; "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Agent SDK products need API keys | Remote start is possible without API keys only if Claude Code runs where the user is signed in (their machine, or Anthropic's cloud under their account). Nothing Claude-related is ever stored on Railway except a routine's own fire token (F13) |
| F12 | Remote Control has a server mode that accepts NEW sessions from the phone | `claude remote-control` "stays running ... waiting for remote connections"; `--spawn same-dir\|worktree\|session`, `--capacity`, `--permission-mode`. Permission prompts and `AskUserQuestion` are forwarded to the phone. All plans | Starting implement from the phone already works today with zero code |
| F13 | Cloud routines have a per-routine HTTP trigger built for outside systems | `POST https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire`, bearer token "scoped to triggering that routine only", beta header `experimental-cc-routine-2026-04-01`, optional free-text `text` that arrives labelled as untrusted data (the saved prompt must opt in). Runs as the individual user on their subscription, daily run cap, research preview | A sanctioned "laptop is off" path exists, one routine per developer |
| F14 | A routine's VM starts from a fresh clone | Skills "committed to the cloned repository" are available; default branches are `claude/`-prefixed; network is an allowlist; connectors are included with full write access and no prompts | The cycle directory and the taskflow config are gitignored, so a routine needs `taskflow pull --full`. The status-only provider rule would be prose-only there: leave the provider connector out of the routine |
| F15 | claude.ai connectors reach Claude Code sessions and routines | Routines doc: connectors "are the claude.ai integrations on your account"; connector traffic is routed through Anthropic, so it needs no network allowlist entry | One MCP endpoint on the server serves Claude Code, the Claude phone app and routines |

## Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Who owns which state | **Split ownership: one writer per datum.** The laptop owns pipeline state (index, batch files, plans, attachments) as files, exactly as today, and pushes a snapshot. The server owns human state (question status, answers, claims, audit log). Neither side writes the other's data | triage and implement are 1,300 lines of prompt that read and write JSON with file tools. Moving pipeline state behind an API rewrites both skills and puts a network call in every state change. With one writer per datum there is nothing to merge. It extends the 1.4.0 rule ("pipeline state is read-only; the report owns one file") |
| D2 | Where the gate lives | **The claim is the gate.** Claiming a batch is one server transaction: accept the pushed snapshot, check the questions, compare-and-swap the claim row, return the answers | One code path, atomic, and it cannot read stale state because the push is part of the call. It also replaces the `mkdir` lock with a real lock that works across machines |
| D3 | Gate rule | A batch is claimable only when every `blocking` question on every task in it is `answered` or `dropped`, **and** the stored fingerprint matches the current question text. `sent` does not pass. Non-blocking open questions warn and pass | "Stop me when it is not answered fully." A reworded question invalidates its answer until the developer confirms it still applies (one click) |
| D4 | Escape hatch | None on the command. The way past an open question is to mark that question `dropped` in the dashboard, with a note | The decision is recorded on the question instead of vanishing in a `--force` flag |
| D5 | Server unreachable | implement fails closed | The gate data lives on the server. Without it nothing can be verified |
| D6 | Question shape | One `needs[]` entry per question, key `q-<slug>`, plus optional `options[]` for either/or questions | F2. The dashboard renders one answer box per question |
| D7 | Answer identity | Keyed `(project, task_id, key)`, not by cycle. Append-only rows; the newest wins. Each row snapshots the question text it answered | F10. Survives `/taskflow:clean` and carry-over. An answer stays readable after the question is reworded or removed |
| D8 | Lane rule | New reason `waiting-on-answers`. Such a batch leaves Ready; auto-claim moves on to the next one. This replaces "a claimable batch with an open client question stays in Ready with a marker" | Ready must keep meaning "what implement would claim" |
| D9 | One source for the claim rule | New pure module `gate.mjs` (dependencies + questions -> claimable, reason, claim order). Used by `model.mjs` for lanes and by the claim endpoint. implement stops re-implementing the rule in prose: it asks the server | Removes the existing `model.mjs` <-> SKILL Step 1 duplication instead of adding a third copy |
| D10 | Browser auth | GitHub OAuth, scope `read:user` only. Users live in the database. `ADMIN_GITHUB_LOGINS` bootstraps instance admins on first sign-in; everyone else is invited by GitHub login into a project. An uninvited login sees a "not invited" page and no data. Server-side sessions, 30-day rolling; cookie `HttpOnly; Secure; SameSite=Lax` | No password to store or brute-force. A long session matters on a phone |
| D11 | CLI auth | Bearer token per user, created in the dashboard, stored hashed. On the laptop: `~/.config/taskflow/credentials.json`, mode 0600, keyed by server URL. The server takes the user from the token, never from a slug in the request body | Never in the repository, never in the project config. Every write is attributable |
| D12 | Storage | Railway Postgres only. Snapshot as `jsonb`, plan files as text rows, attachments as content-addressed `bytea` (sha256), 10 MB cap per file | One stateful thing to back up; the app service stays stateless. 11 MB per cycle today. A Railway volume would add: one volume per service, no replicas, downtime on redeploy |
| D13 | Code layout | Same repository. Root `package.json` (`start: node server/main.mjs`, single dependency `pg`) and `railway.json` with healthcheck `/api/health`. Everything under `scripts/` stays zero-dependency | F8. The plugin still installs by git clone; Claude Code ignores `package.json` |
| D14 | Local mode | Kept. File adapters stay as the test and offline-viewer backends. `/taskflow:report` prints the hosted URL when `server_url` is configured | The tests run on file fixtures. The answer UI is written once against the store interface |
| D15 | Tenancy | **One deployment = one team.** Many users and many projects inside it; not a shared SaaS | Ticket text is client-confidential. Isolation between unrelated tenants is the most expensive security property to get right and keep right; a Railway template makes a private instance one click. Inside an instance, isolation is per project through membership |
| D17 | Roles, per project | `admin` (members, settings), `developer` (own cycle, CLI token, claim, answer, drop), `answerer` (sees questions with their task title and summary, answers them; no plans, no lanes, no token) | Colleagues who hold the answers can type them in directly. One `authorize(user, project, action)` function guards every data route; every query carries `project_id` |
| D18 | What is per user, what is per project | Per user: cycle (`project` + `user`), claims, tokens, sessions. Per project: answers and question state, keyed `(project, task_id, key)` | Two developers triage different tasks, so their cycles and claims never collide. An answer follows its task when the task is reassigned |
| D19 | PR and worktree state | Collected on the laptop by the existing `enrich.mjs` and sent with the push. The server holds no GitHub repository token in v1 | In a multi-user instance a server-side token would need access to every project's repository. The pushing user's own `gh` login already has exactly the right access. Cost: PR state is as fresh as the last push |
| D20 | Mobile | Designed phone-first for the answering flow; see "Mobile" | Goal 6 |
| D21 | Whose answer opens the gate | An answer counts when its author holds `developer` or `admin` on the project. An `answerer`'s answer is `proposed` until a developer accepts it (one tap). Every answer records `via`: `web` or `mcp` | Answers are fed to a code-writing agent. The developer stays the person who vouches for that input, and an answer recorded through Claude is visibly marked so an invented one can be spotted |
| D22 | Claude as a second interface | The server exposes one remote MCP endpoint (`/mcp`) over the same service functions as the HTTP API. `push` and `claim` stay in the CLI | F15. A remote MCP server cannot read the laptop's files, and the gate must stay an exit code |
| D23 | Starting implement from the app | Three tiers, in order: Remote Control server mode (exists today), a local runner, a cloud routine. See "Starting implement from the app" | F11–F14 |
| D24 | What a start request may contain | A project, a batch key and the requesting user. Never prompt text | The start channel reaches a developer's machine. A fixed vocabulary keeps a compromised server from turning it into remote code execution |
| D16 | No provider credentials on the server | The Railway service has no ClickUp token at all | The status-only rule becomes structural: the dashboard cannot write to ClickUp |

## Architecture

```
laptop                                         Railway
------                                         -------
skills/triage      writes files        push    server/main.mjs (node:http + pg)
skills/implement   writes files   ─────────▶     source-pg.mjs   RawCycle from Postgres
scripts/taskflow.mjs (CLI, zero-dep)             store-pg.mjs    question state, answers, claims
  push | claim | release | answers    claim      gate.mjs        shared, pure
  questions | status | login     ◀─────────      model/inbox/markdown/ui   reused unchanged
                                   answers      Postgres
browser  ── GitHub OAuth ──────────────────▶   dashboard: read pipeline state, write answers
```

Adapter interfaces (both have a file and a Postgres implementation):

- `CycleSource.read(cycleId) -> RawCycle` — shape of `read.mjs` today: `cycle, index, batchFiles, locks,
  plans, attachments, summaryFile, config, problems`. On the server `locks` comes from the `claim` table.
- `HumanStore`: `load(project)`, `setResolution(itemId, ...)`, `addAnswer(itemId, ...)`, `confirmAnswer(itemId)`.
- `watch.mjs` is not used on the server: the model version bumps on a push or on a human write, then broadcasts.
- `enrich.mjs` runs on the laptop inside `taskflow push`; its result is part of the snapshot and the server
  feeds it to `model.mjs` as the `enrichment` argument, with the push time as `asOf`.
- The project config gains `"server": { "url": "...", "project": "<project key>" }`. No secrets there.

### Push

`taskflow push` is idempotent (running it twice equals running it once) and two-phase so nothing is re-uploaded:

1. `PUT /api/sync/cycle` — index, batch files, summary, worktree list, and a manifest of plan files and
   attachments as `{id, sha256, size}`. The server answers with the hashes it does not have.
2. `PUT /api/sync/blob/<sha256>` for each missing one.

Called at: end of triage, inside `claim`, after every batch-file write in implement, after the PR is created,
and by `/taskflow:clean` (which flips the server cycle to archived). The dashboard header shows
"pushed N minutes ago" and `dev_head`, so a stale mirror is visible instead of silent.

Cycle identity: triage writes a `cycle_id` (uuid) into a new index; the CLI falls back to `last_triage`.

### Claim

`taskflow claim [batch-key] [--stack]`:

1. push (above);
2. `POST /api/claim` — in one transaction: build the RawCycle, run `gate.mjs`, insert the claim row
   (partial unique index on unreleased claims gives compare-and-swap);
3. on success write `<output_dir>/claim.json` and `<output_dir>/answers/<task-id>.md`, create the local
   `.lock` directory so the local viewer stays truthful.

| Exit | Meaning | Output |
|---|---|---|
| 0 | claimed | batch key, tasks, path to answers |
| 2 | blocking questions open | each question: task, title, state (`open`, `sent`, `changed`), dashboard link |
| 3 | already claimed | by which host, since when; offers resume when it is this host |
| 4 | server unreachable or unauthorised | what to check |
| 5 | dependency not complete (named claim only) | which; re-run with `--stack` to stack on its branch |
| 6 | nothing claimable | per-batch reason |

`taskflow release <batch-key>` replaces `--unlock`.

### Skill changes

- **implement Step 1.3–1.5:** replace the `mkdir` claim logic with `taskflow claim`. Non-zero exit: print
  the output and stop. Step 3 (worktree) refuses to run without `claim.json` for that batch.
- **implement Step 1.7:** read `answers/<task-id>.md` next to each plan. When an answer contradicts the
  plan's Approach, rewrite Approach and Risks before coding (same path as today's Step 2 option c).
- **implement Step 2:** a low-confidence task whose blocking questions are all answered no longer prompts.
- **implement:** `taskflow push` after each batch-file write.
- **triage Step 7a:** one need per question (D6). Before writing, call `taskflow questions <task-id>` and
  reuse the key of any question that is the same question. Drop the `delivered` values `description`
  and `comment`; delivery is a human act, recorded as `sent` in the dashboard.
- **triage Step 3.5 and Step 4:** remove the `link_tasks` and description `update_task` calls (already
  owed from the status-only rule). Enrichment text goes to the plan file only.
- **clean:** push the archive flip.

### Dashboard changes

- Question item: answer box (markdown), "source" field (who, where, when — free text), states
  `open -> sent -> answered | dropped`, a `changed` state with "answer still applies" and "re-answer".
- Answer history per question.
- Batch strip: "waiting on N answers" with the hatched blocked treatment; links to the questions.
- Header: project switcher, cycle switcher (mine / a teammate's, read-only), last push age, `dev_head`, sign-out.
- Settings: create and revoke your CLI tokens; admins manage members and roles.
- Answerer view: the question list only (task title, summary, question, answer history).

### Mobile

The phone's job is answering; the desk's job is the whole queue. Same code, no build step.

- **Below ~720 px the queue and the detail pane are separate screens**: list, tap, full-screen detail with a
  back control. Navigation goes through the History API so the phone's back gesture works.
- **"Needs you" is the phone's home screen.** A bottom tab bar switches between Needs you, Queue and Cycle notes.
- **Answer composer:** full-width text area; input text at 16 px or more (iOS zooms the page below that); the
  Save bar is sticky, respects `env(safe-area-inset-bottom)` and follows `visualViewport` so the keyboard
  never covers it.
- **Drafts are saved per question in `localStorage`** as you type: mobile browsers evict background tabs.
- **Saving is idempotent** (the request carries an idempotency key, so a double tap or a retry after a dropped
  connection produces one answer). A failed save stays on screen with a retry, never silently lost.
- **`options[]` questions render as large tap targets**: an either/or question is one tap.
- **Asking is a share-sheet action:** "Send question" uses `navigator.share` where it exists (falls back to
  copy), so the paste-ready text goes straight into Slack or Messages. It marks the question `sent`.
- Touch targets 44 px or more; nothing depends on hover; the screenshot lightbox supports pinch and swipe.
- Installable (web app manifest, `display: standalone`). **No service-worker caching of ticket data** in v1:
  client text is not persisted on the phone.
- Live updates: a hidden tab already closes its stream and refetches when it becomes visible; that is the
  normal case on a phone, not the exception.
- **Verification:** every UI phase is checked in Playwright device emulation (an iPhone and a Pixel profile) and
  from screenshots at 360, 390 and 430 px, in both themes, in addition to the desktop widths.

## Claude as a second interface (MCP)

One endpoint, three surfaces: Claude Code (bundled in the plugin), the Claude phone and desktop apps (added as a
custom connector), and cloud routines (connectors come along automatically).

| Tool | Does | Role |
|---|---|---|
| `list_open_questions(project, batch?)` | open, sent, changed and proposed questions with task title and summary | any member |
| `get_question(id)` | full text, options, answer history | any member |
| `answer_question(id, body, source, fingerprint)` | records an answer, `via: mcp`; `proposed` when the caller is an answerer (D21) | any member |
| `mark_sent(id)`, `drop_question(id, note)`, `accept_answer(id)` | state changes | developer |
| `cycle_status(project)` | lanes, what is claimable next and why not | developer |
| `request_start(project, batch_key)` | queues a start request (D24) | developer |

New skill `/taskflow:answers`: walks the open questions one at a time. In Claude Code it also has the plan file and
the code, so when an answer contradicts the plan's Approach it can re-plan on the spot — the one thing the web form
cannot do. The skill records only what the user states; it never infers an answer.

Auth, in two steps:

1. **Bearer token** — the plugin's `.mcp.json` points at `${TASKFLOW_URL}/mcp` with
   `Authorization: Bearer ${TASKFLOW_TOKEN}` (environment expansion). Enough for Claude Code.
2. **OAuth** — the server acts as an OAuth authorization server for MCP clients and delegates the actual sign-in to
   GitHub. Needed for a claude.ai custom connector. Use the official MCP SDK's server and auth helpers on the
   server side (allowed by D13) rather than a hand-written OAuth server. *To confirm in a spike:* the exact
   requirements claude.ai places on a custom connector (dynamic client registration, callback URL).

## Starting implement from the app

Constraint (F11): Claude Code must run where the user is signed in. The Railway service never runs Claude and never
sees a Claude credential.

**Tier 0 — Remote Control server mode. Exists today, nothing to build.**
A standing `claude remote-control` in the project directory (under tmux or pm2). From the Claude phone app: new
session on that machine, then `/taskflow:implement batch-N`. Prompts and questions are forwarded to the phone. Use
the default `--spawn same-dir`: the cycle directory is gitignored, so it does not exist inside a spawned worktree,
and implement creates its own worktree anyway. The dashboard's part: a "Copy start command" action on every Ready
batch.

**Tier 1 — local runner. The button.**
`taskflow runner` is a small zero-dependency process on the developer's machine. It holds an *outbound* connection
to the server (no open port, no tunnel), authenticated with that user's CLI token. "Start" in the dashboard inserts
a `start_request` row; the runner picks up only its own user's requests for projects configured on that machine,
validates the batch key against the local index, and launches the unmodified `claude` binary in a detached tmux
session with Remote Control on and `/taskflow:implement <batch-key>` as the initial prompt. It reports back
`started | refused | failed` and, if it can be read reliably, the session URL so the button becomes "Open in Claude".
The claim gate still applies inside the run: a batch with open questions exits 2 and the request shows as refused.
Launching interactively (not `claude -p`) means implement's remaining prompts reach the phone instead of having to be
removed. *To confirm in a spike:* a machine-readable way to get the session URL; the permission mode to launch with.

**Tier 2 — cloud routine. Laptop off. Spike before committing.**
Each developer creates their own routine with an API trigger and stores its fire URL and token in their taskflow
settings (encrypted at rest with `SECRET_KEY`; this is a trigger token the docs intend for external systems, not a
Claude login). The routine's saved prompt opts in to reading only a batch key from the fire text. Work it needs:
`taskflow pull --full` for state *and* config (both gitignored), the plugin's skills available in the clone (not
confirmed for plugins; vendoring is the fallback), a cached setup script, the Railway domain on the environment's
network allowlist or all traffic through the MCP connector, branch naming (default `claude/` prefix), and the
provider connector left out so the status-only rule cannot be bypassed (the status change then happens from the
laptop or by hand). Costs: research preview, daily run cap, draws the user's subscription usage.

**Ruled out:** Claude credentials or `CLAUDE_CODE_OAUTH_TOKEN` on the server; the Agent SDK on a subscription.
**Ranked below:** GitHub Actions with `claude-code-action` (documented, but one repository secret is one person's
subscription, which does not fit several developers, and it needs the same hydration work as a routine); channels
(research preview, and they feed one long-lived session, where a fresh session per batch is better).

Security of the start channel: D24 (no prompt text), requests expire after 10 minutes, the runner is opt-in per
machine and per project, every request and outcome lands in `audit_log`. Plans are read from local files, never from
the server. Answers do come from the server, so implement is told to treat them as quoted data, D21 keeps a developer
between an answerer and the agent, and the pull request review stays the final human check.

## HTTP surface (additions)

| Route | Auth | Purpose |
|---|---|---|
| `GET /auth/github`, `/auth/callback`, `POST /auth/logout` | none / session | sign-in |
| `PUT /api/sync/cycle`, `PUT /api/sync/blob/<sha>` | token | push |
| `POST /api/claim`, `POST /api/release` | token | gate + lock |
| `GET /api/answers?batch=`, `GET /api/questions?task=` | token | pull for implement / triage |
| `POST /api/answer`, `POST /api/answer/confirm` | session | write an answer; 409 on stale fingerprint |
| `POST /api/inbox` | session | existing resolution ticks |
| `POST /api/tokens`, `DELETE /api/tokens/<id>` | session | your own CLI tokens |
| `GET /api/projects`, `POST /api/projects` | session | projects you belong to; create one |
| `GET/POST/DELETE /api/projects/<id>/members` | session, project admin | invite by GitHub login, change role, remove |
| `POST /api/answer/accept` | session, developer | accept an answerer's proposed answer (D21) |
| `POST /mcp` | token, later OAuth | MCP endpoint (Phase 2) |
| `POST /api/start` | session, developer | queue a start request (Phase 3) |
| `GET /api/runner/events`, `POST /api/runner/report` | token | the runner's outbound stream and its status reports (Phase 3) |

Every data route takes a project (path or query) and passes through `authorize(user, project, action)`.
A project the user does not belong to answers 404, not 403, so its existence does not leak.
| `GET /api/health` | none | name + version only, no data |

Everything else without a session redirects to sign-in (pages) or returns 401 (API).

Security carried over: CSP, `nosniff`, static allowlist, attachment sandbox CSP, escape-first markdown.
Changed: Host allowlist and the CSRF Origin check read `PUBLIC_URL`; failed sign-ins and bad tokens are
rate-limited; every human and CLI write lands in `audit_log`.

## Database

```sql
app_user(id bigserial primary key, github_id bigint unique, login text, name text, avatar_url text,
         is_instance_admin boolean, created_at, last_seen_at)
project(id text primary key, name text, created_by)
membership(project_id, user_id, role text check (role in ('admin','developer','answerer')),
           primary key (project_id, user_id))
invite(project_id, github_login, role, invited_by, created_at)   -- consumed at first sign-in

cycle(id uuid primary key, project_id, user_id, last_triage, dev_head, is_live boolean,
      snapshot jsonb,           -- index, batch files, summary, enrichment, config subset
      pushed_at timestamptz, pushed_from text)
-- unique (project_id, user_id) where is_live

plan_file(cycle_id, task_id, sha256, body text, primary key (cycle_id, task_id))
blob(sha256 text primary key, content_type, size int, body bytea)
attachment(cycle_id, task_id, name, sha256 references blob)

question_state(project_id, task_id, key, resolution, fingerprint, title, note, updated_at,
               primary key (project_id, task_id, key))

answer(id bigserial primary key, project_id, task_id, key,
       body text, source text,
       question_fingerprint text, question_text text,   -- what was actually answered
       idempotency_key text unique,
       via text check (via in ('web','mcp')),
       accepted_by bigint references app_user, accepted_at timestamptz,   -- D21; set at insert for developers
       created_at timestamptz, created_by bigint references app_user)
-- append-only; latest row per (project_id, task_id, key) wins; the gate reads accepted rows only

start_request(id bigserial primary key, project_id, user_id, batch_key,
              status text check (status in ('queued','started','refused','failed','expired')),
              detail jsonb, session_url text, created_at, updated_at)        -- Phase 3
routine_trigger(user_id, project_id, fire_url text, token_encrypted bytea)  -- Phase 3, Tier 2 only

claim(id bigserial primary key, project_id, cycle_id, batch_key, user_id, host, claimed_at, released_at)
-- unique (cycle_id, batch_key) where released_at is null

session(id, user_id, expires_at)
api_token(id, user_id, token_hash, label, created_at, last_used_at, revoked_at)
audit_log(at, user_id, project_id, action, payload jsonb)
```

Removing a member revokes their tokens and sessions. Deleting a project cascades to everything under it.

Migrations: numbered `.sql` files applied at boot under a Postgres advisory lock, tracked in `schema_migrations`.

## Railway

- One project, two services: the app (from this repository's root) and Postgres.
- Variables: `DATABASE_URL` (reference to the Postgres service, private network), `PUBLIC_URL`,
  `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `ADMIN_GITHUB_LOGINS`, `SESSION_SECRET`,
  `SECRET_KEY` (encrypts stored routine tokens; Phase 3).
  `PORT` is injected by Railway; bind `0.0.0.0`.
- A Railway template (app + Postgres + the variable prompts) is the install path for other teams (D15).
- Deploy source: GitHub integration on `rentorious/taskflow`. This needs the local commits pushed.
  Until then `railway up` from the clone deploys without a push.
- Postgres backups: enable the scheduled backup on the Postgres service volume. The answers are the only
  data that cannot be regenerated; everything else re-pushes from the laptop.
- Healthcheck `/api/health`. Single replica.

## Phases

**Phase 0 — structured questions and a local gate (no infrastructure). Done in 1.5.0.**
As built: `gate.mjs` (pure; `blocksClaim`, `evaluateClaim`), `answers.mjs` + `human.mjs` (the `HumanStore`
interface over `answers.json` and the per-cycle tick file), `cycle.mjs` (the one path from a directory to a
view model, shared by server and CLI), `scripts/taskflow.mjs`, answer routes and composer, index schema v3,
`provider_enrichment` flag. Differences from the text below: there is no `<output_dir>/claim.json`; the
claim record is `batches/<key>.lock/claim.json`. Exit `7` was added for "already complete or stale".

triage writes one need per question; status-only patch to triage; `gate.mjs` + tests; `HumanStore`
interface with the file backend; answer box in the UI; `taskflow claim` against the local store;
implement uses it. One-off backfill of the four prose questions in the 09-18 cycle.
*Done when:* implement on a batch with an open blocking question exits 2 and lists it; answering it
in the local dashboard lets the claim through and the answer shows up next to the plan.

**Phase 1 — hosted, multi-user, phone-first.**
`server/main.mjs`, Postgres adapters, migrations, GitHub OAuth, users / projects / memberships / invites,
`authorize()`, CLI tokens, push (with laptop-side enrichment), server-side claim, the phone layout, the
"Copy start command" action (Tier 0), Railway deploy and template.
*Done when:* an answer typed on a phone unblocks a claim on the laptop; a second claim of the same batch
exits 3; a signed-out request to any data route gets no data; a member of project A gets 404 on project B;
the answering flow passes the phone checks in "Mobile".

**Phase 2 — Claude as an interface.**
`/mcp` with bearer auth, the tools above, `/taskflow:answers`, the plugin's `.mcp.json`. Then the OAuth
server and the claude.ai connector. Answerer view and D21 acceptance.
*Done when:* every open question of a batch can be answered by talking to Claude Code, and the same from the
Claude phone app; an answerer's answer does not open the gate until accepted.

**Phase 3 — start from the app.**
`start_request`, `taskflow runner`, the Start button and its states. `taskflow pull --full` (also what makes a
second machine possible). Then the routine spike, and a go / no-go on Tier 2.
*Done when:* Start on the phone opens a session on the laptop that shows up in the Claude app; a request for a
batch with open questions comes back refused with the questions listed; a request carrying anything but a
valid batch key is rejected by the runner.

**Throughout:** answer history, archive browsing on the server, retention for archived attachments, a device-style
`taskflow login` to replace pasting a token.

## Out of scope

- Writing anything but a status to the provider.
- People without a GitHub account (most clients) answering directly. The schema leaves room (`source`,
  `created_by`); it would need per-question capability links.
- Running Claude anywhere but the user's own machine or their own Anthropic cloud account.
- Triggering triage from the dashboard.
- Offline implement.
- A shared multi-tenant service (D15).

## Decided with the developer (2026-09-18)

- D10 GitHub sign-in; several users per deployment.
- D4/D5 no force flag; implement fails closed when the server is unreachable.
- Phone-first UI.

- D1 split ownership, D15 one deployment per team, D21 an answerer's answer needs a developer's
  acceptance, D23 tier order (MCP before the Start button). All four confirmed.

## Amendments (2026-09-18, while planning Phase 1)

Checked against the code and the vendors' documentation. Where an amendment contradicts the text
above, the amendment wins.

| # | Above | Amended to | Why |
|---|---|---|---|
| A1 | D13: root `package.json`; "Claude Code ignores `package.json`" | `server/package.json` and `server/package-lock.json`, nested. The plugin root holds no manifest. Deploys build from a root `Dockerfile` | Claude Code runs `npm ci --ignore-scripts` for any plugin whose root holds a `package.json` and a lockfile, and that cannot be turned off. A nested manifest keeps plugin installs inert. Railpack needs a root manifest to detect Node, hence the Dockerfile |
| A2 | D13 and "Railway": `railway.json` | No `railway.json`. Dockerfile, service settings and the template carry the configuration | Railway deprecated Config as Code; the files stop being read on 2026-12-01 |
| A3 | D10: OAuth scope `read:user` | No scope | A token with no scope already returns `id`, `login`, `name` and `avatar_url`. Sign-in uses `state` and PKCE (S256) |
| A4 | "Cycle identity … falls back to `last_triage`" | `<output_dir>/cycle.<slug>.json`, `{cycle_id, created_at}`, created once by the CLI with an exclusive create. No fallback | `last_triage` is a date, is rewritten on re-triage and is not unique. `/taskflow:clean` archives unknown top-level files, so the id travels with its cycle. A new live id for the same project and user archives the previous live cycle in the same transaction |
| A5 | Database: global `blob`; `plan_file`; `attachment`; `snapshot jsonb`; no tick table | `blob` keyed `(project_id, sha256)`. One `cycle_blob(cycle_id, project_id, sha256)` reference table replaces `plan_file` and `attachment`; names, sizes and modification times stay in the snapshot's manifest. `snapshot json`. New `inbox_tick(project_id, cycle_id, item_id, …)`. `question_state` gains `text`; `answer` gains `question_title` and `public_id` | A global content-addressed store lets a member of one project name another project's hash in a manifest and read that file, and "which hashes are missing" is an existence oracle. `jsonb` reorders object keys and the view model iterates in insertion order. `POST /api/inbox` needs somewhere to write. The client compares answer ids as strings |
| A6 | F6: "the server swaps two adapters" | The reusable unit is a report handler over a backend object (`handler.mjs`, `backend-files.mjs`) | `server.mjs` also reads disk for the cycle list, the cache signature, the summary, attachments and the watcher, and owns the loopback-only security checks |
| A7 | D21 | An unaccepted answer never stamps `question_state`; accepting it does. "Newest answer" means newest accepted | A question's state is derived from the recorded resolution alone, so a stamped but hidden answer would open the gate |
| A8 | One-time import (not covered above) | First wins per question: a question that already has a row on the server is skipped and listed; the rest is imported; re-running is a no-op. The live cycle's tick file is imported too | Never merges within a question, and does not strand a second developer's local answers |
| A9 | D14: "The 63 tests" | 134 at the start of Phase 1 | — |
| A10 | HTTP surface: JSON routes for tokens, projects and members | Server-rendered, script-free pages under `/settings` that post plain forms (`form-action 'self'` on those pages only; the dashboard keeps `'none'`). `GET /api/me` answers for a session or a token | The only client of those routes would have been a page written here anyway. No script means nothing to inject into |
| A11 | "CSRF Origin check reads `PUBLIC_URL`" | A write must carry the page's own `Origin`, or, when the browser withheld it, `Sec-Fetch-Site: same-origin` | Chromium sends `Origin: null` on a same-origin form post under `Referrer-Policy: no-referrer`. Fetch metadata is set by the browser and cannot be forged by page script. Found in a real browser, not by the HTTP tests |
| A12 | D17, D21: the answerer | The role, invites for it and the proposal rule in the store exist. The answerer's view and the accept action stay in Phase 2, as the phase list above already says. Until then an answerer who signs in is told so | Nothing in Phase 1 can create a proposal |
| A13 | D17: who writes where | You write on your own cycle, in a browser. A teammate's cycle is read-only ("cycle switcher … a teammate's, read-only"). A CLI token reads, and will push and claim; it never records an answer | An answer must come from a person looking at the question |
| A15 | Push, claim: `PUT /api/sync/cycle`, `POST /api/claim`, … | The same routes under `/api/p/<project>/…` (`sync/cycle`, `sync/blob/<sha>`, `claim`, `release`, `archive`, `import`, `state`), always about the asker's own cycle | The project is in the path, so one check resolves the asker's role before anything else runs |
| A16 | "locks comes from the claim table" | Claims win; the lock directories the laptop saw stay underneath as a hint | A lock from before the project was hosted, or another session on the same machine, is still real. `release` pushes again so a removed lock disappears at once |
| A17 | `GET /api/answers`, `GET /api/questions` | One `GET …/state` returns the model and this developer's records; the CLI renders `answers/<task>.md`, `questions` and `status` from it with the code it already had | One rendering path, hosted or not |
| A14 | D10: instance admins | They create projects and become admin of what they create. Being an instance admin opens no project they were not added to | Ticket text is confidential per project |

### Phase 1 as sliced

1. **1a** — handler and backend seam; `server/` with `pg`, migrations, Postgres source and HumanStore,
   payload and ingest; a hosted app that binds loopback only and refuses every write; a seed tool.
2. **1b** — GitHub sign-in, sessions, users, projects, memberships, invites, `authorize()`, CLI tokens;
   HTTP writes turn on; the answerer role.
3. **1c** — push and server-side claim in the CLI; the one-time import; skill edits.
4. **1d** — deploy one instance to Railway.
5. **1e** — the phone layout.
6. **1f** — Railway template, continuous integration, documentation for other teams.

Without sign-in configured the server starts only when `PUBLIC_URL` is a loopback origin, read-only.
The rule is "no authentication configured, so require loopback"; setting the four sign-in variables
lifts it (1b, done). 1a, 1b and 1c are built (plugin 1.6.0); see `server/` and `scripts/report/remote.mjs`.

## Amendments B (2026-10-08, pivot: the app is the interface, the machines are the hands)

Decided with the developer on 2026-10-08, after Phase 1 went live (2026-09-29). Where a row here
contradicts the text above, including "Amendments" A1–A17, this row wins.

**What changed in the premise.** Two developers, a few clients, a non-commercial tool. Both developers
have always-on machines where a daemon may run and start `claude` whenever work is queued. A commercial
release is not planned; if it ever were, it would move to API keys and the Agent SDK, so nothing below
is constrained by that case. F11 still holds in full: Claude runs on a developer's machine under that
developer's own login, and the Railway service never runs Claude and never holds a Claude credential.

**Verified against the Claude Code docs before writing this block (2026-10-08).** `--session-id <uuid>`
lets the caller choose the id before launch (cli-reference). A transcript is appended live as JSONL at
`~/.claude/projects/<project>/<session-id>.jsonl`; its format is internal and changes between versions
(sessions). `--remote-control` is interactive-only and cannot be combined with `-p`; the terminal shows
an `/rc active` link, and no machine-readable way to read that link is documented (remote-control). A
session started with `-p` persists and can be resumed interactively with `--resume <id>` (sessions).
`--dangerously-skip-permissions` equals `--permission-mode bypassPermissions`; `--worktree` creates
`<repo>/.claude/worktrees/<name>` (cli-reference). NOT documented, so each is a spike before 2a: the
fields of the final `stream-json` `result` event; what `-p` does when the model calls `AskUserQuestion`;
what the CLI prints and exits with when the subscription window is used up; whether a reused
`--session-id` is refused.

| # | Above | Amended to | Why |
|---|---|---|---|
| B1 | D23: "Three tiers, in order: Remote Control server mode, a local runner, a cloud routine"; "MCP before the Start button" | **The runner is the foundation, not a tier.** It is built first. MCP moves after it and changes purpose (B12). Tier 0 ("Copy start command") stays as the fallback. Tier 2 (cloud routine) is dropped from the plan | The developers' machines are always on, so "laptop off" is no longer a case to design for. If the app is where work is dispatched, the thing that dispatches must exist before anything that talks to it |
| B2 | `start_request(project, batch_key)`; "Triggering triage from the dashboard" out of scope | **A job queue.** `job(id, project_id, kind, args jsonb, requested_by, machine_id, state, session_id, worktree, cost_usd, duration_ms, started_at, finished_at, error, created_at)` with `state ∈ queued \| running \| needs-input \| done \| failed \| refused \| expired`. `kind` is a closed vocabulary, each kind with its own args schema: `triage`, `implement(batch_key)`, `address-review(pr)`, `fix-ci(pr)`, `review(pr)`, `uat(batch_key)`, `demo(batch_key)`, `set-status(task_id, status)`. D24 stands: never prompt text, only a kind and validated args. Triage from the dashboard is in scope | One table and one runner loop for every action the dashboard can start. A closed vocabulary keeps the server from being able to say anything to a developer's machine except names it already knows |
| B3 | "launches the unmodified `claude` binary in a detached tmux session with Remote Control on" | **Headless, with a mod that routes questions to the dashboard.** The plugin ships a mod (`hooks/register.js`, inert unless `TASKFLOW_JOB_ID` is set). The runner mints the session id and runs `claude -p --session-id <id> --output-format stream-json --permission-mode auto` with the skill invocation as the prompt, inside a worktree. The mod registers `mcp__taskflow__ask(question, options?)`; the skills call it where they would ask a human (a `tool.call` hook on `AskUserQuestion` redirects that tool the same way in a promoted session). The hook posts the question to `/api/p/<project>/jobs/<id>/questions`, the dashboard shows it and pushes (B7), and the hook **waits inside the tool call** by looping ≤25 s long-polls until the answer arrives or a cap (15 min) passes; the answer returns as the tool result and the session continues in place. Past the cap the tool returns "parked", the job becomes `needs-input`, and when the answer lands the runner runs `claude -p --resume <id> "<answer>"`. Remote Control is no longer the question path: `claude --resume <id> --remote-control` in tmux stays available as a manual "chat with this session" action (**shipped 2026-10-09** as the `chat` job kind: pinned to the machine that holds the session, opened in a detached tmux window named `taskflow-<job>` with the Remote Control session named after the job, no job environment so the mod stays inert; the job ends at once with the pane's first lines as its result, and a second chat finds the window instead of opening another) | Verified 2026-10-08 with a throwaway mod: a registered tool is offered and called under `-p`; time inside `$.http.fetch` is excluded from the 10 s hook budget (a 70 s wait across three polls returned the answer, budget untouched), but one fetch is capped at 30 s, hence the loop; `-p --resume <id>` with a new message continued a finished session and recalled its earlier tool calls (1.9 s, one turn). Waiting inside a tool call costs no tokens; a resume is a fresh process and a cold cache, so it is the fallback, not the path |
| B4 | PR and worktree state "as fresh as the last push" (D19) | **A live job log.** The runner forwards the `stream-json` events of a running job to `POST /api/p/<project>/jobs/<id>/events` (batched, bearer token); the server stores them per job and fans them out over the existing SSE channel. The dashboard shows a job pane: current tool call, last assistant text, elapsed time, and after the end the cost and duration from the `result` event. For a promoted interactive session the runner tails the transcript JSONL instead, parsed defensively (only `type`, role and content-block names), because that format is internal | Watching a session from the phone is the one thing the Claude app does that the dashboard did not. With the event stream it does, for the price of a forwarder. The transcript tail is best-effort by design: it must degrade to "running" when the format changes, never fail the job |
| B5 | (not covered) | **The scheduler is rate-aware.** Per machine: a concurrency cap (default 1), FIFO within a project, oldest project first across projects. When a job ends because the subscription window is used up, the runner marks it `failed(usage-limit)` with the reset time if it can be parsed, pauses the machine until then, and the dashboard shows the pause. Jobs expire unclaimed after 10 minutes unless the kind says otherwise (`uat` 1 h) | The subscription window, not the machine, is the scarce resource. Five parallel sessions use the window by noon and then everything waits anyway; a queue with a cap spends it in order |
| B6 | "the permission mode to launch with" (a spike) | **`acceptEdits`, with `ask` routed to the dashboard.** Every Claude job launches with `--permission-mode acceptEdits` plus the project's own permission allow rules; `--dangerously-skip-permissions` is not used anywhere. (`auto` was the first choice; under `-p` it behaved as `default` here — a plain `ls` was denied — so it is a later spike, not the path.) The mod's `tool.check` hook sees the mode's decision: `allow` and `deny` pass through unchanged, `ask` becomes a permission question on the dashboard (tool, command or path, the classifier's reason), answered with the same push, wait and park mechanism as B3; the answer returns `allow` or `deny`. Unanswered past the cap = `deny`, and the session goes on. The runner still holds an allow-list of job kinds per machine; `set-status` is one provider call by the runner, not a Claude session; no job kind can touch a production database, a deploy or a secret | Verified 2026-10-08: under `-p` with `auto`, `git push --force` came back `ask` ("This command requires approval"), which plain `-p` turns into a silent denial listed in the result's `permission_denials`; the mod's `tool.check` returning `{ decision: 'allow' }` made the same command run. The classifier's own `deny` is left alone on purpose. Bypass was only ever a workaround for "nobody can answer the prompt"; now someone can |
| B7 | 1e: "NO service worker"; the dashboard notifies nothing | **Web Push, accepted 2026-10-08.** A push-only service worker (it shows the notification and opens the linked page; no caching, no offline), VAPID keys on the server, one subscription row per browser, zero-dependency signing with Node's `crypto`. Events: a job asks a question or a permission (B3, B6), a job finished or failed, a pull request was opened, a question was answered on your cycle, a usage pause began. On iPhone, push works only once the dashboard is added to the home screen (iOS 16.4+), and the permission prompt must follow a tap. **Shipped 2026-10-09:** `server/push.mjs` (VAPID and aes128gcm over `node:crypto`, checked byte for byte against RFC 8291's own example), `005_push.sql`, `/api/push/subscriptions` and `/api/push/test` (a browser session only, never a token), `/sw.js` served at the root so one browser holds one subscription however many boards it opens, a **Notify me** button on the board. Events wired: a question or a permission asked by a job, a job done, failed or refused, a pull request URL new to the server (diffed when the cycle is pushed), a usage pause. Not wired: "a question was answered on your cycle" (today only the owner answers; it comes with the client view, B13) | The point of the pivot is not having to watch. The 1e rule was about offline caching, which stays out. A Telegram bot was the alternative; first-party push deep-links into the job and needs no bot account |
| B8 | D16, D19: no provider or repository credentials on the server (stand) | **Webhooks in, credentials still out.** The server accepts GitHub webhooks (`pull_request_review`, `check_suite`, `pull_request` closed/merged) and ClickUp webhooks (`taskCreated`, `taskUpdated` on the configured lists), verifies their signatures, and turns them into jobs (`address-review`, `fix-ci`) or inbox items (new sprint task → "triage?" tick; PR merged → `set-status` job + batch archive). All writes to GitHub and ClickUp are still made by the runner with that developer's own `gh` and ClickUp credentials | The review loop closes without the server holding a token that could write to every repository. A webhook secret can only make the server believe an event happened; the runner still validates the job against local state before acting |
| B9 | "the runner picks up only its own user's requests for projects configured on that machine" | **Machines are first-class.** `machine(id, user_id, name, last_seen_at, kinds text[], concurrency)` registered by the runner on connect. A job may be pinned to a machine; `implement` records the machine that holds the worktree, and `address-review`, `fix-ci`, `uat`, `demo` for that batch are pinned to it. Unpinned jobs go to any online machine of the requesting user that lists the kind. The dev stack (database, search, pm2) lives on one machine, so `uat` is pinned there by configuration | A worktree cannot be resumed from the other laptop. Saying so in the data model is cheaper than discovering it in a failed job |
| B10 | "Launching interactively … means implement's remaining prompts reach the phone instead of having to be removed" | **Skills must not block when headless.** Before 2a, triage and implement are audited for every point that waits on a human (implement has two today). Each becomes either a question asked before the job starts (a `needs[]` entry, so the existing gate carries it) or a documented default. A session that still asks (the `AskUserQuestion` tool in `-p` mode is undocumented, spike) is what triggers the B3 promotion, not the normal path. **Done 2026-10-09:** the audit found seven waits in implement, not two (claim exit `3` in both its cases, exit `5`, the low-confidence prompt of Step 2, checks failing after two fixes in Step 4d and again in Step 5, the existing-worktree confirm) and one in triage (identity missing from memory). Each now calls `mcp__taskflow__ask` when the tool exists (B3), with one-tap options, and names its default for a session nobody can answer (neither `ask` nor `AskUserQuestion`): resume, release-and-reclaim, stop, skip the task, stop, stop, resume; triage stops. The pre-start `needs[]` route stands for what triage can foresee; these eight are things only the run discovers | A headless job that stops to ask is a failed job with extra steps. The gate already exists to front-load human input; use it |
| B11 | D12: "10 MB cap per file"; artefacts are cycle attachments only | **Job artefacts.** `uat` and `demo` attach screenshots and videos to the batch through the A5 blob store, keyed to the job; the per-file cap is 50 MB for job artefacts; they are archived with the cycle and deleted 30 days after archive | Nearly every batch in this project ends with "UAT owed". A job that runs the Playwright recipes and leaves the evidence on the batch page removes that debt by default. Video needs the larger cap; retention keeps Postgres from becoming a video archive |
| B12 | "Claude as a second interface": `/mcp` as the answering interface; `answer_question` etc. | **MCP later, as a dispatch interface.** When built, the tools are `cycle_status`, `list_jobs`, `enqueue_job(kind, args)`, `list_open_questions`, `answer_question`. The claude.ai connector (OAuth server) stays a spike. The plan-aware `/taskflow:answers` skill is dropped: answers are typed in the app, and a re-plan is an `implement` job that reads them | With the app as the interface, Claude-as-interface is a convenience, not the path. Enqueuing from the Claude phone app ("start batch 3") is the one thing it adds |
| B13 | "Out of scope: … answering directly (most clients)" | **Client view, last.** The `answerer` role grows into a per-project client page: sprint progress, demo videos, the questions addressed to them, and an approve action. Still GitHub sign-in; capability links for people without GitHub stay out | The questions already exist; the videos will. Showing them to the client replaces comment ping-pong in the provider. Deferred because nothing above depends on it |
| B14 | Provider: fixed `lists[]` in the config | **Sprint-aware provider.** A project may name a ClickUp *sprint folder* instead of lists; triage resolves the active sprint list at cycle start and never reads the backlog. One cycle = one sprint; `/taskflow:clean` at sprint end. Status maps are per project. One server project per client, each with its own provider config on the laptop | Two developers, several clients, sprints and a backlog. The cycle already has the shape of a sprint; naming it so costs one provider lookup |
| B15 | "Out of scope: Running Claude anywhere but the user's own machine or their own Anthropic cloud account" (stands) and nothing on commercial use | **Not a product.** Subscription use on the developers' own machines is the model. No multi-tenant release, no API keys, no hosted runner. If that ever changes, it is a new design, not an amendment | Keeps every decision above honest about who it is for |

### Phases, re-cut (replaces "Phase 2" and "Phase 3" above)

**Phase 2 — the runner.** Done when: Start on the phone runs implement headless on the developer's
machine, the log is watched from the phone, a pull request appears, and a session that needs a human
pings the phone and opens in the Claude app.

1. **2a** — `job` and `machine` tables (`004_jobs.sql`), `/api/p/<project>/jobs` (create, list, get,
   events), `/api/p/<project>/machines`; `taskflow runner` (zero-dependency, outbound long-poll with the
   CLI token, allow-list and launch flags per kind, worktree per job); the `implement` kind headless
   with the stream-json forwarder; the mod with `ask` and the `tool.check` route (B3, B6); questions and
   permissions in the job pane. The spikes named above were run on 2026-10-08 and all passed.
2. **2b** — the park-and-resume path (`-p --resume` with the answer), the manual "chat with this session"
   action (`--resume` in tmux with Remote Control), Web Push with a push-only service worker, the `triage`
   kind, the implement/triage audit of B10.
3. **2c** — scheduler hardening: concurrency, usage-limit pause (the mod reads `$.session.usage().rateLimits`
   after every turn and the runner reads `rate_limit_event`), expiry, machine pinning, audit log rows for every
   job transition; `set-status` as a runner-made provider call.

**Phase 3 — webhooks.** GitHub and ClickUp webhooks with signature checks; `address-review`, `fix-ci`,
`review`; PR merged → `set-status` + archive. Done when a review comment from the second developer
produces a fix commit without anyone opening a terminal.

**Phase 4 — evidence.** `uat` and `demo` kinds, artefact storage and retention, the batch page shows them.

**Phase 5 — sprints and clients.** Sprint-aware provider, one project per client, the client view.

**Later** — MCP as dispatch (B12), the claude.ai connector spike, the Railway template (1f).
