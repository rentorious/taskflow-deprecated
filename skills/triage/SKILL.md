---
name: triage
description: Use when asked to triage project management tasks, process task lists, plan task batches, or when user invokes /taskflow:triage. Fetches to-do tasks, classifies them, creates implementation plans, and groups into smart batches.
---

# Taskflow Triage (`/taskflow:triage`)

Pull, classify, plan, and batch tasks from your project management tool for the current developer. Produces per-task implementation plan files, a state file for `/taskflow:implement` to consume, and a human-readable summary.

All behavior is driven by `.claude/taskflow-config.json` — no provider-specific details appear in the main workflow. Provider-specific MCP tool mappings are in the appendix at the bottom of this document.

## Invocation

```
/taskflow:triage              # Triage all to-do tasks assigned to you
/taskflow:triage --force      # Re-triage already-triaged tasks (rewrite plans, reclassify)
```

---

## Prerequisites

Before starting, verify:

1. **Config file exists** at `.claude/taskflow-config.json` — if not, stop immediately:
   > "No taskflow config found. Run `/taskflow:setup` first."

2. **Provider MCP server is connected** — check for the MCP tools that match `config.provider` (e.g., ClickUp tools start with `clickup_`). If the tools are not available, stop:
   > "Provider MCP server (`<config.provider>`) is not connected. Check your MCP configuration."

3. **Developer identity is in Claude memory** (full name + provider user ID)

**If developer identity is missing from memory:**

- Ask: "I don't have your identity saved. What's your full name?" (as a job: `mcp__taskflow__ask`, no options; when nobody can answer, stop: "Developer identity is not in memory and nobody can be asked. Run `/taskflow:triage` once in a terminal to save it.")
- Use `find_member(name)` to look up their provider user ID
- Confirm the ID with the developer (as a job: `mcp__taskflow__ask` with options `["Yes, that's me", "No"]`)
- Save name and provider user ID to Claude memory before proceeding

---

## Running as a Job — nobody is watching the terminal

When a tool named `mcp__taskflow__ask` is in your tool list, the taskflow runner started this session headless from the hosted dashboard: no terminal, no `AskUserQuestion`, and a question written as text ends the job with nothing done. Triage has one point that waits on a human, the identity check above. There, call `mcp__taskflow__ask` with a question that stands alone on a phone, treat the result as the developer's reply, and never end a turn waiting for one. A result that says the job is PARKED means nobody answered in time: stop, change nothing further, and end your turn with one line saying where you stopped; the runner resumes this session with the answer quoted. When neither `mcp__taskflow__ask` nor `AskUserQuestion` exists, nobody can answer: take the default the step names. Everything else in triage runs without a person: questions for the client are written into `needs[]` (Step 4), never asked in the session, and the summary plus the push at Step 9 are the job's result.

---

## Provider Writes — status only by default

Taskflow writes to the provider as little as it can. The ticket is the client's document; the plan files and the report are ours. Three kinds of write exist, and two of them are off unless the config turns them on:

| Write | Config flag | Default |
| ----- | ----------- | ------- |
| Task status change | none | always allowed (triage itself makes none; implement does) |
| Comments (`add_comment`) | `provider_comments` | **off** |
| Description enrichment (`update_task` with a `description`) and task links (`link_tasks`) | `provider_enrichment` | **off** |

A flag is on only when it is exactly `true`. A missing key, `null`, or `false` all mean off.

**When a flag is off:**

- Never make that call, for any reason, anywhere in this workflow — not as a courtesy, not because a step further down seems to need it.
- Every gated block below has a **local fallback**: the content lands in the plan file, the index and the summary instead. Nothing is lost.
- Do not print "updated in the provider", "commented in the provider", "linked in the provider" or similar in terminal output or the summary file.

**When a flag is `true`:** run the blocks gated by that flag exactly as written.

---

## Step-by-Step Process

Follow these steps in order. Do not skip or reorder steps.

---

### Step 1: Load Context

1. Read `.claude/taskflow-config.json` — parse fully. Store the entire config object for use throughout the workflow.

2. Read developer identity from Claude memory:
   - Full name (e.g., "Ognjen Popovic")
   - Provider user ID (e.g., "96691755")
   - Derive `developer_slug`: first name, lowercase (e.g., "ognjen")

3. Read provider config: `config[config.provider]` — extract workspace info and lists.

4. Determine target list(s): use the list(s) where `default: true` unless the user specified a different list. If multiple lists are marked default, use all of them.

5. Check for existing state file at:

   ```
   <config.output_dir>/state.<developer_slug>.json
   ```

   - If it exists, parse it and load the `tasks` map
   - Note which task IDs already have `status: "planned"`, `"in-progress"`, `"pr-created"`, or `"done"` — these are "already triaged"
   - If `--force` was passed: ignore the already-triaged set (re-triage everything)
   - If `--force` was NOT passed: keep the already-triaged set — you will skip these in Step 2

6. Note today's date in `YYYY-MM-DD` format for use in output filenames.

---

### Step 2: Fetch Tasks

1. For each target list, call `fetch_tasks(list_id, "todo", developer_id)` to retrieve tasks with "to do" status assigned to the current developer.

2. Merge results from all lists and deduplicate by task ID.

3. For each returned task, call `get_task(id)` to retrieve full details:
   - Title (`name`)
   - Description — may be empty
   - Task URL
   - Status, assignees, tags
   - Priority and due date (if set) — used for batch ordering in Step 6
   - Attachments — list them (id, filename, type). Image and PDF attachments CAN be viewed — see "Viewing attachments" below.

4. For each task, call `get_comments(id)` to retrieve comment content — may reveal additional context.

   **Viewing attachments (images, PDFs):** for any task whose description alone is insufficient, pull its viewable attachments before classification:

   1. Call `download_attachment(task_id, attachment_id)` to get a download URL. The URL is short-lived (~5 min) and may be single-use — use it immediately, exactly once; never preview, HEAD-request, retry, or store it.
   2. Download right away: `curl -sL -o <config.output_dir>/attachments/<task-id>/<filename> "<url>"` (create the directory first).
   3. Read the downloaded file with the Read tool — images render visually; PDFs are readable page by page.

   If a download fails or the URL expired, call `download_attachment` again for a fresh URL. Non-viewable formats (`.docx`, `.zip`, video) can still be downloaded but not Read — note their existence and filename instead.

5. **Filter already-triaged tasks** (when not using `--force`):
   - Cross-reference each returned task ID against the already-triaged set from the state file
   - Separate into two lists:
     - `new_tasks`: task IDs not in state file, or with `status: null`
     - `stale_check`: task IDs currently in state file — verify their provider status is still `todo`
   - For `stale_check` tasks: if their status has changed away from `todo` (e.g., moved to `in_progress`, `in_review`, or `done`), mark them as `stale` in the state file and exclude from triage
   - Only triage `new_tasks` (and all tasks if `--force`)

6. If the merged task list is empty or returns no tasks:
   - Print: "No to-do tasks assigned to you in the configured list(s)."
   - Stop execution.

7. If after filtering there are zero tasks to triage, report:
   - "All assigned to-do tasks are already triaged. Use `/taskflow:triage --force` to re-triage."
   - Still update stale task statuses in the state file and stop.

---

### Step 3: Classify Each Task (Parallel Agents)

For each task that needs triage, dispatch one classification agent using the Agent tool. Run all agents in parallel — do not wait for one to finish before starting the next.

**Input each agent receives:**

- Task ID
- Task title
- Task description (may be empty)
- Comment content (if any)
- Local file paths of any downloaded attachments (from Step 2) — the agent must Read image/PDF attachments before classifying, plus a note of any attachments that could not be downloaded or viewed
- The classification schema and rules below
- The `config.areas` and `config.extra_areas` from the config file

**Each agent must search the codebase and return a classification object:**

```json
{
  "task_id": "<id>",
  "area": "<area from config>",
  "type": "bug|feature|copy-change|investigation",
  "complexity": "small|medium|large",
  "confidence": "high|medium|low",
  "implementable": "yes|partial|no",
  "summary": "One-paragraph description of what needs to be done, in plain language.",
  "unclear": "What information is missing or ambiguous. null if confidence is high.",
  "files": ["relative/path/to/relevant/file.ts"],
  "approach": "Step-by-step description of how to implement this.",
  "time_estimate_human": "Estimated time for a human developer familiar with the codebase (e.g., '30 min', '2 hours', '4-6 hours').",
  "time_estimate_agent": "Estimated time for an AI coding agent with full codebase access (e.g., '10 min', '30 min', '1-2 hours')."
}
```

#### Time Estimate Guidelines

Estimates must reflect the **specific task**, not just the complexity bucket. A one-line `replaceAll` fix and a tricky state-management bug are both "small" but have very different time profiles. Use the ranges below as hard bounds — place your estimate within them based on the number of files touched, whether debugging/investigation is needed, whether external systems are involved, and how much edge-case handling the approach requires.

**Human estimates** — developer who knows the codebase, includes context-switching and manual testing:

- `small` complexity: 15 min – 1 hour
- `medium` complexity: 1 – 4 hours
- `large` complexity: 4 – 8+ hours

**Agent estimates** — AI agent with instant codebase access, no context-switch cost, human review after:

- `small` complexity: 5 – 15 min
- `medium` complexity: 15 min – 1 hour
- `large` complexity: 1 – 3 hours

Bump toward the top of the range (or beyond for large) when: investigation is needed before implementation, visual verification is required, external systems must be changed (third-party dashboards, email templates), or the approach has significant unknowns.

#### Classification Rules

**`area`** — Where the change lives:

Area options come from two sources:
- **Code areas:** the keys of `config.areas` (e.g., `"storefront"`, `"admin"`, `"backend"`, `"common"`)
- **Non-code areas:** the values in `config.extra_areas` (e.g., `"sendgrid"`, `"manual"`)

For each code area, use `config.areas[area].description` to understand what it covers, and search the directories listed in `config.areas[area].paths` to find relevant files.

Rules:
- Assign a non-code extra area (e.g., `"manual"`) for tasks that cannot be done in code — data entry, content in a CMS, admin UI data changes, non-code configuration. Set `implementable: no` for these.
- If a task spans multiple areas (e.g., backend API change + storefront UI change), pick the primary area and note the secondary area in `summary`. Set complexity to at least `medium`.

**`type`**:

- `bug`: Something is broken, erroring, or not working as expected. A regression.
- `feature`: New functionality that doesn't exist yet.
- `copy-change`: Text or content update — labels, headings, descriptions, error messages. Usually `small` complexity.
- `investigation`: Needs research or testing before implementation can be scoped. No clear solution known. Assign `confidence: low` and `complexity: medium` minimum.

**`complexity`**:

- `small`: Single file or component, obvious fix, under ~1 hour. Routine change.
- `medium`: Multiple files or components, moderate logic, 1–4 hours.
- `large`: Architectural change, new feature spanning many files, significant logic, database migrations, 4+ hours.

**`confidence`**:

- `high`: Task description is clear, the affected code is findable in the codebase, the approach is obvious.
- `medium`: General intent is clear but some ambiguity — e.g., which specific component, exact behavior expected, edge cases.
- `low`: Insufficient information. Vague title with no description and no viewable attachment, task requires context you cannot access (e.g. a video walkthrough or an external dashboard), or deeply ambiguous requirements. A clear screenshot counts as information — a screenshot-only task can be `high` confidence if the image makes the problem obvious.

**`implementable`**:

- `yes`: Fully implementable via code changes only.
- `partial`: Code changes needed + manual steps outside code (e.g., update a template in an external dashboard, enter data in the admin, update a third-party config).
- `no`: Entirely manual — no code changes needed or possible.

#### Codebase Search Instructions for Agents

For each area, search the directories listed in `config.areas[area].paths`. Use these heuristics:

- Look for pages, components, hooks, styles, and API utility calls in frontend areas
- Look for API routes, services, models, subscribers, and migrations in backend areas
- Look for shared types and DTOs in shared/common areas
- Check for references to external services (email template IDs, third-party API calls) in subscriber and service directories

When searching, use keyword matching on component names, route paths, UI labels, or feature names extracted from the task title. If the task mentions a specific UI element by name, search for that string in the relevant area's paths.

#### Special Case: Screenshot-only Tasks

If a task has an empty or near-empty description (title only) but has image attachments:

1. Download and Read the image(s) first (see "Viewing attachments" in Step 2). Do not classify until you have looked at them.
2. Classify based on what the screenshot actually shows, combined with the title. Identify the page or component by matching visible UI text from the screenshot against the codebase.
3. Assign `confidence: low` only if the task is still ambiguous after viewing — e.g. it's unclear what in the image is wrong, or the expected behavior is unknowable from the image.

Never fabricate specifics about an image that failed to download. If the download fails even with a fresh URL, fall back to `confidence: low` and say so in the `unclear` field.

---

### Step 3.5: Cross-Task Relatedness Pass

Classification agents run in isolation and cannot see each other's results. This step runs in the orchestrator, comparing ALL classification objects before enrichment and batching. Build a relatedness map with three relationship types:

**1. Duplicates** — two tasks describing the same defect or request. Compare titles, summaries, and any attachments viewed in Step 2 (two screenshots of the same broken page = strong duplicate signal).

- Pick the canonical task: the one with more context, or the older one if equal.
- **Link (gated — see "Provider Writes" above).** Only if `config.provider_enrichment` is `true`: call `link_tasks(duplicate_id, canonical_id)`. Flag off (default): make no provider call. The `duplicate_of` entry in the index and the Duplicates section of the summary record it.
- **Comment (gated).** Only if `config.provider_comments` is `true`: `add_comment` on the duplicate in the developer's voice, e.g. "This looks like the same issue as <canonical task title> — tracking it there." Flag off: skip it.
- The duplicate gets `batch: null` and `duplicate_of: "<canonical-task-id>"` in the index. Do not write a plan file for it.
- Never change the duplicate's status or close it — leave that to the developer.

**2. File overlap** — tasks whose `files` lists intersect. These MUST land in the same batch in Step 6 (see Rule 2 there). Two batches editing the same file means two parallel worktrees producing guaranteed merge conflicts.

**3. Connected features** — tasks that are part of the same feature or user-facing concern but touch different files. Prefer the same batch when complexity limits allow; otherwise split into separate batches with a `depends_on` relationship if one builds on the other (see Step 6, Rule 6).

For every related group, add a "## Related Tasks" section to each member's plan file in Step 5, listing the other task IDs and the relationship (`duplicate-of`, `same-files`, `same-feature`). An implement session working one batch must be able to see the full picture.

---

### Step 4: Draft the Questions

Anything you need from a person before a task can be built becomes a **question**. Questions are the input of the claim gate: `/taskflow:implement` refuses to start a batch while one of its blocking questions has no recorded answer. The developer gets the answers from the client or a colleague and types them into the report. So a question has to be something a person can answer on its own, and the report has to be able to tell whether each one was.

**Locate the taskflow CLI first.** It ships with this plugin at `scripts/taskflow.mjs`. Resolve it in this order and stop at the first path where `test -f <path>` succeeds:

1. `${CLAUDE_PLUGIN_ROOT}/scripts/taskflow.mjs`
2. `<skill base directory>/../../scripts/taskflow.mjs`, where the skill base directory is the one announced at the top of this skill when it was loaded (it ends in `skills/triage`).

Never reuse a path remembered from an earlier session. If neither exists, carry on without it and tell the developer at the end that recorded answers may ask to be re-confirmed.

#### 4a. When to ask

- Every `confidence: low` task gets at least one question, and it is `blocking: true`.
- A `confidence: medium` or `high` task gets a question for each open point that changes **what** gets built. `blocking: true` when the Approach depends on the answer. `blocking: false` when you can build on a stated assumption and only want it confirmed — write that assumption into the plan's "Risks / Unknowns".
- Do not ask what the ticket, its comments or its attachments already answer. Do not ask about **how** to build it; that is your job.

#### 4b. One question per entry

**Never bundle.** "Do balances expire, and can a card be split across orders?" is two entries. If your draft contains "and", "also" or a numbered list, split it. The developer ticks questions off one at a time as answers arrive, and a half-answered bundle would hold the batch with no way to say which half is missing.

Each question is one `needs[]` entry in the index (Step 7a):

| Field | How to write it |
| ----- | --------------- |
| `key` | `q-` plus two to four words, kebab-case: `q-gift-card-expiry`. Lowercase letters, digits and dashes only, 32 characters at most, unique within the task |
| `title` | Imperative, names who to ask, 80 characters or fewer: "Ask Dana whether gift card balances expire" |
| `text` | Paste-ready, in the developer's voice, and **self-contained**: the developer pastes this one question into a chat on its own, so it must carry its own context and not lean on the other questions. Markdown allowed |
| `to` | First name of the person who can answer |
| `blocking` | See 4a |
| `options` | Only when the answer is a choice between known alternatives: two to eight short strings, e.g. `["Portrait, 2:3", "Square"]`. The report turns them into one-tap answers. Leave it out for open questions |

**Voice — it must sound like the developer wrote it, not an AI:** first person, short sentences, conversational; technical and direct where that helps the reader; no "Upon analysis…", no "As per the requirements…". If the task creator's name is known, use it.

> "Hey Dana, on the inventory screenshot — is it the totals row that's wrong, or the line items?"

#### 4c. Keep recorded answers attached — reuse the exact wording

Answers live outside the cycle, keyed by task and question key, together with the wording they were given for. Before writing questions for a task, ask what is already on record:

```bash
node <taskflow_cli> questions <task-id> --dir <absolute path of config.output_dir>
```

It prints JSON: `questions[]` (what is asked today, with `key`, `title`, `text`, `options`, `state` and the recorded `answer`, if any) and `no_longer_asked[]` (answers recorded against questions that are gone).

- **The same question as before → copy `key`, `title`, `text` and `options` exactly, character for character.** The report compares the wording. Any edit, even fixing a typo, marks the recorded answer "the question changed" and holds the batch until the developer confirms it still applies. Reword only when the meaning really changed.
- **A question that already has an `answer` → plan with that answer.** Keep the entry, verbatim, so the answer stays attached and visible; write the plan's Approach as the answer directs.
- **`no_longer_asked` settles something you were about to ask → do not ask again.** Build the answer into the plan and say in "Risks / Unknowns" where it came from.
- A genuinely new question gets a new key. Never reuse a key for a different question.

#### 4d. Where the questions go

- The index, as `needs[]` entries (Step 7a). This is what the report shows and what the gate reads.
- The task's plan file, under `## Open Question`: one bullet per question, `` `<key>` `` first, then the text (Step 5).
- The summary file's "Questions for the client" section (Step 8).
- **Comment (gated — see "Provider Writes" above).** Only if `config.provider_comments` is `true`: also `add_comment(id, ...)` with the question text.

The questions are always drafted and written locally, flags or no flags — a disabled flag suppresses the posting, never the thinking.

#### 4e. Description enrichment (gated — off by default)

**Only if `config.provider_enrichment` is `true`.** Flag off (the default): make no `update_task` call with a description, for any task. What you would have written there is the plan file's "What Needs to Change" section; nothing else is needed.

Flag on: call `update_task(id, {description: ...})` in the developer's voice — what is broken or wanted (1–2 sentences), which part of the codebase is involved, the intended approach. For `confidence: medium`, flag what is uncertain in-line. For `confidence: low`, write only what the title and attachments establish. **Append to the client's description; never replace it.** If the write fails, add an `owed-write` need (Step 7a) holding the text.

---

### Step 5: Create Implementation Plan Files

For each task (including `implementable: no` tasks), write a plan file to:

```
<config.output_dir>/tasks/<task-id>.md
```

Create the `<config.output_dir>/tasks/` directory if it does not exist.

**Plan file format:**

```markdown
# <Task Title>

**Task:** <task_url>
**Area:** <area> | **Type:** <type> | **Complexity:** <complexity> | **Confidence:** <confidence>
**Time Estimate (Human):** <time_estimate_human> | **Time Estimate (Agent):** <time_estimate_agent>

## What Needs to Change

<summary from classification — plain English description of what's broken or needs building>

## Files Involved

- `path/to/file.ts` — what changes in this file
- `path/to/other.ts` — what changes in this file

## Approach

<Numbered step-by-step implementation plan. Be specific enough that another developer or agent can follow it without additional context. Reference function names, component names, or API endpoints where known.>

## Risks / Unknowns

<Anything that could go wrong, decisions that need to be made, or things that need verification before or during implementation. Write "None identified." if genuinely clear.>

## Manual Steps (if partial)

<Steps the developer must take outside of code — e.g., "Update the email template in the external dashboard to change the subject line". Write "N/A" if implementable: yes.>

## Dependencies

<Other task IDs that should be implemented first, with a brief reason. Write "None." if independent.>

## Related Tasks

<Other task IDs from the Step 3.5 relatedness map, with the relationship (duplicate-of, same-files, same-feature) and a brief note. Write "None." if independent.>

## Open Question

<One bullet per question drafted in Step 4, in the same order as the task's `needs[]`: the key in backticks, whether it blocks, then the text verbatim.
- `q-<key>` (blocking) — <text>
- `q-<key>` (does not block; assuming <the assumption>) — <text>
Omit this section entirely for a task with no questions. If `config.provider_comments` is `true` the same text was also posted as a comment — note "(posted as a comment)" after it.>
```

**For `implementable: no` tasks**, use this condensed format:

```markdown
# <Task Title>

**Task:** <task_url>
**Area:** <area> | **Type:** manual | **Complexity:** <complexity> | **Confidence:** <confidence>
**Implementable:** No — manual task

## What Needs to Happen

<Description of the manual work required.>

## Why Not Automated

<Brief reason — e.g., "Requires data entry in the admin dashboard", "Email template UI change with no code equivalent", "Content update in an external system".>
```

Write all plan files to disk before moving to Step 6.

---

### Step 6: Group Tasks into Batches

Create batch groupings from the classified tasks. Apply these rules in order:

**Rule 1 — Exclude non-implementable tasks from batches:**
Tasks with `implementable: no` go into a separate "manual" group. They are listed in the summary but assigned `batch: null` in the state file.

**Rule 2 — Group by relatedness first:**
Use the relatedness map from Step 3.5. Tasks that touch the same feature area, the same files, or are clearly part of the same user-facing concern belong in the same batch. For example: multiple email template issues -> one batch; multiple storefront product page issues -> one batch.

File-overlap groups are mandatory: tasks whose `files` lists intersect must share a batch even if that exceeds the Rule 3 caps — raise the cap for that batch rather than split the group across two worktrees.

**Rule 3 — Then apply complexity limits per batch:**

- Max 5 `small` tasks per batch
- Max 3 `medium` tasks per batch
- `large` tasks: always isolated — one large task = one batch, never combined
- Mixed small + medium: treat as medium rules (max 3 total)

**Rule 4 — Low-confidence tasks can be batched but are flagged:**
Do not isolate them just because confidence is low. They will be reviewed by the developer before `/taskflow:implement` starts on them.

**Rule 5 — Name each batch descriptively:**
Pick a batch name that describes what the batch accomplishes, e.g.:

- "Email template fixes"
- "Product page UI bugs"
- "Inventory search improvements"
- "Admin order management features"

**Rule 6 — Record batch dependencies:**
If a batch builds on another batch's changes — the same feature split across batches by the Rule 3 caps, or a plan file's "Dependencies" section pointing at a task in another batch — record `depends_on: ["<batch-key>"]` on the dependent batch in the index. `/taskflow:implement` will not claim a batch before its dependencies have PRs.

**Rule 7 — Number batches in claim order:**
`/taskflow:implement` claims batches in key order (batch-1 first), so numbering IS prioritization. Assign numbers by:

1. Provider priority (urgent/high first), then nearest due date
2. Quick wins next — small-complexity, high-confidence batches before large or risky ones
3. A batch that others depend on always gets a lower number than its dependents

---

### Step 7: Write State and Batch Files

Write the triage output as a read-only index file plus per-batch working files.

#### 7a. Write the index file

Write to `<config.output_dir>/state.<developer_slug>.json`.

This file is the **read-only index** — it contains task classifications and batch assignments. `/taskflow:implement` reads this file but never writes to it.

**Index file schema (`schema_version: 3`):**

```json
{
  "schema_version": 3,
  "last_triage": "YYYY-MM-DD",
  "developer": "<Full Name>",
  "developer_id": "<provider_user_id>",
  "dev_head": "<short sha of origin/<config.base_branch> this triage read the code at>",
  "summary_file": "triage-<developer_slug>-<YYYY-MM-DD>.md",
  "tasks": {
    "<task-id>": {
      "name": "<task title, verbatim from the provider>",
      "short_name": "<your own label for the task, 70 characters or fewer>",
      "summary": "<one line: what needs to change>",
      "url": "<task url>",
      "priority": "<urgent|high|normal|low, from the provider>",
      "classification": {
        "area": "<area>",
        "type": "<type>",
        "complexity": "<complexity>",
        "confidence": "<confidence>",
        "implementable": "<yes|partial|no>",
        "time_estimate_human": "<e.g., '30 min', '2-4 hours'>",
        "time_estimate_agent": "<e.g., '10 min', '30-45 min'>"
      },
      "batch": "<batch-1|batch-2|null>",
      "needs": [
        {
          "key": "q-<two-to-four-words>",
          "kind": "question",
          "title": "<imperative, 80 characters or fewer, e.g. 'Ask Dana which report is wrong'>",
          "text": "<one self-contained question, paste-ready, in the developer's voice (markdown allowed)>",
          "to": "<first name of the person who has to answer>",
          "blocking": true,
          "options": ["<only for a choice between known alternatives>", "<…>"]
        },
        {
          "key": "q-<another-question>",
          "kind": "question",
          "title": "<…>",
          "text": "<…>",
          "to": "<…>",
          "blocking": false
        }
      ]
    }
  },
  "batches": {
    "batch-1": {
      "name": "<human-readable batch description>",
      "tasks": ["<task-id-1>", "<task-id-2>"],
      "suggested_branch": "<branch-name>",
      "depends_on": [],
      "rationale": "<one or two sentences: why these tasks go together and why the batch sits at this position>"
    }
  },
  "suggestions": [
    {
      "key": "<kebab-case, stable>",
      "title": "<imperative, e.g. 'File a ticket: refunds round the wrong way'>",
      "text": "<what you found and where>",
      "found_in": "<task-id you were planning when you found it>"
    }
  ]
}
```

Field notes:
- Tasks have classification data only — no `status`, `branch`, `pr_url`, or `commit_shas` (those live in per-batch files)
- Batches have `suggested_branch` (a suggestion from triage), not `branch` (which implement confirms)
- `batch`: `null` for manual/non-implementable tasks
- `depends_on`: batch keys that must reach `pr-created` before this batch is claimable; empty array if independent
- Duplicate tasks (Step 3.5) get `batch: null` plus `duplicate_of: "<canonical-task-id>"` in their task entry
- `short_name`: provider titles are often a full sentence or a paragraph. Write the label you would use yourself. The report shows this in its queue and keeps `name` for the detail view
- `time_estimate_*`: lead with the number or range (`"2-4 hours"`). Anything after a comma or bracket is shown as a caveat, never summed
- A task you found already fixed gets `batch: null`, `"already_fixed": true` and a `"note"` saying what fixed it and what is left to do before it can be closed (markdown allowed). The report turns that into a "verify and close" item

**`needs` — what this task is waiting on from a human.** One entry per question (Step 4): this is what the report's "Needs you" inbox shows, what the developer answers, and what `/taskflow:implement` checks before it will start the batch. Anything that waits on a person belongs here and not only in prose. Always write the array; write `[]` when there is nothing.

| Field | Meaning |
|-------|---------|
| `key` | `[a-z0-9-]`, 32 characters or fewer, unique within the task, `q-…` for questions. **Stable across re-triage**: recorded answers hang off it. A missing, malformed or repeated key does not make the need go away — the report keeps it, blocking, under a generated key and flags the index as faulty |
| `kind` | `question` — something to ask a person. `owed-write` — a provider write that was enabled, was attempted, failed, and must now be done by hand |
| `title` | Imperative and short. It is the row label in the inbox |
| `text` | One self-contained question, paste-ready, in the developer's voice. The same text as the bullet in the plan file's `## Open Question` |
| `to` | First name of the person who answers (questions only) |
| `blocking` | `true` when implement must not start without it. Every `confidence: low` task has at least one blocking question |
| `options` | Optional, questions only: two to eight short strings when the answer is a choice between known alternatives |

Write questions as Step 4 describes. There is no `delivered` field any more: whether a question was sent is something the developer records in the report. An `owed-write` exists only when `config.provider_enrichment` is `true` and a description write failed (`key: "dev-notes"`, `text`: the description you meant to write).

**`suggestions` — findings with no ticket yet.** If planning a task turns up a separate defect or follow-up that no fetched task covers, do not bury it in a plan file. Add one entry here. The `key` must be stable across runs. Write `[]` when there are none.

#### 7b. Write per-batch files

Create the `<config.output_dir>/batches/` directory if it does not exist.

For each batch, write an initial batch file to `<config.output_dir>/batches/<batch-key>.json`.

**Per-batch file schema:**

```json
{
  "status": "pending",
  "branch": null,
  "pr_url": null,
  "tasks": {
    "<task-id>": {
      "status": "planned",
      "commit_shas": []
    }
  }
}
```

Field notes:
- `status`: always `"pending"` for new batches
- `branch`, `pr_url`: always `null` for new batches — `/taskflow:implement` fills these in
- Per-task `status`: always `"planned"` for new tasks
- Per-task `commit_shas`: always empty for new tasks

**Important:** Only write batch files for batches that do not already have a lock directory (`<config.output_dir>/batches/<batch-key>.lock/`). If a lock exists, that batch is claimed by an in-progress implement session — do not overwrite its batch file.

#### Re-triage merge behavior

**If an index file already existed (re-triage run):** Merge the new data into the index:

- Preserve existing task entries that were not re-triaged
- Update entries for tasks that were re-triaged
- Update stale task statuses
- Merge new tasks into the `tasks` map
- Rebuild the `batches` map to reflect all current batches
- `needs` travels with its task entry: untouched tasks keep theirs; a re-triaged task gets a fresh array in which every question that is still the same question keeps its `key`, `title`, `text` and `options` **exactly** (Step 4c), because recorded answers are matched on the key and compared on the wording
- Rebuild `suggestions` from this run, reusing the key of any suggestion that is still valid
- Always write `schema_version`, `dev_head` and `summary_file` for this run

**For per-batch files during re-triage:**

| Batch state | Action |
|-------------|--------|
| Lock directory exists (`batches/<key>.lock/`) | Do not touch — batch is claimed by an active session |
| Batch file has `status: "pr-created"` | Do not touch — batch is complete |
| Batch file has `status: "pending"` (no lock) | Overwrite with fresh data |
| Batch file does not exist (new batch) | Create with initial schema |
| Batch lost all tasks due to staleness | Remove from index, delete batch file |

---

### Step 8: Write Summary File

Write a human-readable summary to:

```
<config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md
```

**Summary file format:**

```markdown
# Triage Summary — <Developer Full Name> — YYYY-MM-DD

## Batches

### Batch 1: <Batch Name>

- **Tasks:** <count> | **Overall Complexity:** <small|medium|large> | **Suggested Branch:** `<branch-name>` | **Depends on:** <batch keys, or "—">
- [ ] <Task Title> (`<task-id>`) — <one-line summary of what needs to change>
- [ ] <Task Title> (`<task-id>`) — <one-line summary>

### Batch 2: <Batch Name>

...

## Manual Tasks (not batched)

- <Task Title> (`<task-id>`) — <why it's manual / what needs to be done manually>

## Duplicates (not batched)

- <Task Title> (`<task-id>`) — duplicate of <canonical task title> (`<task-id>`)

## Questions for the client (answer them in the report)

- <Task Title> (`<task-id>`, <batch-key>)
  - **Ask <name>** (blocking): <question text from Step 4, verbatim, ready to paste>
  - **Ask <name>** (does not block): <question text>

## Stats

- **Total tasks fetched:** <n>
- **New tasks triaged:** <n>
- **Skipped (already triaged):** <n>
- **Stale (moved out of to-do):** <n>
- **Implementable:** <n> | **Partial:** <n> | **Manual:** <n>
- **Batches created:** <n>
- **Low confidence tasks:** <n>
```

Summary notes:

- Every question from Step 4 gets an **Ask** line, one line per question, never bundled. A batch with a blocking question cannot be implemented until that question is answered or dropped in the report: say so once, under the heading. When `config.provider_comments` is `true`, append "(posted as a comment)" to the lines that were.
- In the Duplicates section, append "; linked in the provider" only when `config.provider_enrichment` is `true`, and "; commented" only when `config.provider_comments` is `true`.

For the suggested branch name in each batch, use `config.branch_conventions` to determine the prefix:

- Look up the task type (bug, feature, chore, refactor) in `config.branch_conventions` to get the prefix (e.g., `"fix/"`, `"feat/"`, `"chore/"`)
- If a batch contains mixed types, use the convention for the dominant type
- Append a descriptive kebab-case suffix (e.g., `fix/email-template-bugs`, `feat/admin-order-features`)

---

### Step 9: Print Terminal Summary

After writing files, mirror the cycle to the project's server, if it has one. Resolve `<taskflow_cli>` as in Step 4c and run `node <taskflow_cli> push --dir <absolute path of config.output_dir>` (add `--dev-slug <developer_slug>` when several developers share the directory). It prints "not hosted" and exits 0 when the config has no `server` block, so run it unconditionally. If it exits 4, say so in one line (the output names what to check) and carry on: the files on disk are the triage's result, and the next push repairs the mirror. This sends the index, plans and screenshots to the team's own server. It writes nothing to the task provider.

Then print the summary content directly to the terminal so the developer can review it without opening files.

Then print the file locations:

```
Index file:   <config.output_dir>/state.<developer_slug>.json
Batch files:  <config.output_dir>/batches/batch-N.json (one per batch)
Summary file: <config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md
Plan files:   <config.output_dir>/tasks/<task-id>.md (one per task)
```

Then print:

```
Run /taskflow:report to open the report: what needs you, what is ready, what is blocked.
```

---

## Re-triage Merge Behavior

When `/taskflow:triage` is run again on an existing index file (without `--force`):

| Scenario                                                                                 | Action                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Task is new (not in index)                                                               | Add and triage normally                                               |
| Task is in index with a batch that is claimed (lock exists) or complete (pr-created)     | Skip — do not re-triage in-flight or completed work                   |
| Task is in index with a pending batch (no lock, status pending)                          | Skip unless `--force`                                                 |
| Task is in index but no longer `todo` in the provider                                    | Mark as stale in index; remove from batch file if batch is pending    |
| Batch loses all tasks due to staleness                                                   | Remove from index; delete batch file (only if not locked)             |

When `/taskflow:triage --force` is run:

- Re-triage all `todo` tasks, including already-planned ones in pending batches
- Overwrite plan files and pending batch files with fresh data
- Rebuild batches from scratch for unclaimed work
- Never touch claimed batches (lock exists) or completed batches (status: "pr-created") — even with `--force`

---

## Output File Locations Reference

| File           | Path                                                                |
| -------------- | ------------------------------------------------------------------- |
| Index file     | `<config.output_dir>/state.<developer_slug>.json`                   |
| Batch files    | `<config.output_dir>/batches/<batch-key>.json`                      |
| Batch locks    | `<config.output_dir>/batches/<batch-key>.lock/` (directory)         |
| Summary file   | `<config.output_dir>/triage-<developer_slug>-<YYYY-MM-DD>.md`      |
| Per-task plan  | `<config.output_dir>/tasks/<task-id>.md`                            |
| Inbox ticks    | `<config.output_dir>/report-inbox.<developer_slug>.json` — written by `/taskflow:report`, never by triage |
| Answers        | `<config.output_dir>/answers.json` — written by `/taskflow:report` only. Never read or edit it; ask `taskflow questions <task-id>` instead |

All paths are relative to the project root. Use absolute paths when writing files.

---

## Error Handling

**Provider API errors:**

- If `fetch_tasks` fails: stop and report the error. Do not proceed with stale cached data.
- If `get_task` fails for an individual task: note the failure, skip that task, and continue with others. List skipped tasks in the terminal summary.
- If `update_task` fails for a task (only reachable when `config.provider_enrichment` is `true`): note the failure, add the `owed-write` need, and continue. The plan file still gets written.
- If `add_comment` fails (only reachable when `config.provider_comments` is `true`): note the failure and continue. Comments are not blocking.
- If `download_attachment` fails or the URL expired: call it once more for a fresh URL. If it still fails, proceed without the attachment, classify with what remains, and record the failure in the `unclear` field.

**Missing memory:**

- If developer identity is not in memory: ask before proceeding (see Prerequisites section).

**Empty or minimal task descriptions:**

- Never skip a task because its description is empty. Classify it at `confidence: low` and proceed.
- The plan file still gets written with whatever can be inferred from the title.

---

## Provider Appendix: ClickUp

Use this section when `config.provider` is `"clickup"`.

### MCP Tool Mapping

| Normalized Operation | ClickUp MCP Tool | Notes |
|---------------------|-------------------|-------|
| `fetch_tasks(list_id, status, assignee_id)` | `clickup_filter_tasks` | Pass `list_ids: [list_id]`, `statuses: [status]`, `assignees: [assignee_id]` |
| `get_task(id)` | `clickup_get_task` | Pass `task_id: id` |
| `get_comments(id)` | `clickup_get_task_comments` | Pass `task_id: id` |
| `update_task(id, fields)` | `clickup_update_task` | Pass `task_id: id` + field overrides. **A `description` field is gated — only when `config.provider_enrichment` is `true`. Off by default; see "Provider Writes" above** |
| `add_comment(id, text)` | `clickup_create_comment` | Pass `task_id: id`, `comment_text: text`. **Gated — only callable when `config.provider_comments` is `true`. Off by default; see "Provider Writes" above** |
| `find_member(name)` | `clickup_find_member_by_name` | Pass `name: name` |
| `download_attachment(task_id, attachment_id)` | `clickup_download_task_attachment` | Get attachment IDs from `clickup_get_task` with `include: ["attachments"]`. Returns a short-lived (~5 min), possibly single-use download URL — curl it immediately, exactly once |
| `link_tasks(id, other_id)` | `clickup_add_task_link` | Pass `task_id: id`, `links_to: other_id`. Bidirectional link, no blocking semantics. **Gated — only when `config.provider_enrichment` is `true`. Off by default** |

### Status Mapping

| Normalized | ClickUp Status |
|-----------|----------------|
| `todo` | `to do` |
| `in_progress` | `in progress` |
| `in_review` | `code review` |
| `done` | `done` |
| `cancelled` | `cancelled` |

### ClickUp-Specific Notes

- Task URLs follow the pattern: `https://app.clickup.com/t/<task_id>`
- `priority` and `due_date` come back on `clickup_get_task` — use them for Step 6 batch ordering
- `clickup_filter_tasks` returns tasks with `name`, `id`, `status.status`, `url`, and `assignees` array
- Comments are retrieved separately via `clickup_get_task_comments`
- Attachment IDs come from `clickup_get_task` with `include: ["attachments"]`; content is downloaded via `clickup_download_task_attachment`. The returned URL expires within ~5 minutes and may be single-use — fetch it immediately and exactly once, then Read the local file (images render visually, PDFs page by page)
