-- Work the dashboard asks a developer's machine to do. The server only queues it:
-- a runner on that developer's own machine executes with the unmodified claude
-- binary, and reports back. A job carries a kind and arguments, never prompt text.

create table machine (
  id uuid primary key,
  user_id bigint not null references app_user (id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  kinds text[] not null default '{}',                  -- the job kinds this runner takes
  concurrency int not null default 1 check (concurrency between 1 and 8),
  runner_version text,
  usage json,                                          -- the last rate-limit reading a session reported
  paused_until timestamptz,                            -- a usage-limit pause
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index machine_by_user on machine (user_id);

create table job (
  id uuid primary key,
  project_id text not null references project (id) on delete cascade,
  cycle_id uuid references cycle (id) on delete set null,
  kind text not null check (kind ~ '^[a-z][a-z-]{1,30}$'),
  args json not null default '{}',
  state text not null default 'queued'
    check (state in ('queued', 'running', 'needs-input', 'done', 'failed', 'refused', 'expired', 'cancelled')),
  requested_by bigint not null references app_user (id) on delete cascade,
  machine_id uuid references machine (id) on delete set null,   -- pinned on request, or the one that took it
  session_id uuid,                                     -- minted by the runner before launch
  result json,                                         -- the session's final result event, trimmed
  error text,
  expires_at timestamptz not null,                     -- a queued job nobody took by then is expired
  leased_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index job_queue on job (project_id, state, created_at);
create index job_by_machine on job (machine_id, state);

-- The session's event stream, compacted. What the job pane tails.
create table job_event (
  job_id uuid not null references job (id) on delete cascade,
  seq int not null,
  at timestamptz not null default now(),
  event json not null,
  primary key (job_id, seq)
);

-- A question a running session asks (through the plugin's mod), or a permission the
-- session's mode wanted a human for. Answered in the dashboard; read back by the session.
create table job_question (
  id uuid primary key,
  job_id uuid not null references job (id) on delete cascade,
  project_id text not null references project (id) on delete cascade,
  kind text not null check (kind in ('ask', 'permission')),
  question json not null,                              -- ask: {text, options?}; permission: {tool, input, reason}
  answer json,                                         -- ask: {text}; permission: {decision}
  answered_by bigint references app_user (id) on delete set null,
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  parked_at timestamptz                                -- the session stopped waiting; the answer resumes it
);
create index job_question_open on job_question (project_id, asked_at) where answered_at is null;

-- Bumped by every job write, so an open page learns of one without rebuilding the model.
alter table project add column jobs_rev bigint not null default 0;
