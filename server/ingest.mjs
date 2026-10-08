// A push, on the receiving end. Two steps, so nothing is uploaded twice:
//
//   ingestCycle  takes the payload (scripts/report/payload.mjs) and answers with the
//                hashes of the blobs it does not hold yet
//   putBlob      takes one of those
//
// Both are safe to repeat. Neither trusts what it is sent: the payload is validated,
// a blob is hashed again here, and a cycle id is only ever honoured together with
// the project and the user it belongs to, because the id is minted on a laptop.

import { MAX_BLOB_BYTES, canonicalHash, manifestOf, sha256, validatePayload } from '../scripts/report/payload.mjs';

const PUSHERS = new Set(['admin', 'developer']);
const ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

/** `<last_triage>`, then `-2`, `-3`: the names /taskflow:clean gives its archive folders. */
async function archiveName(q, { projectId, userId, wanted }) {
  const base = typeof wanted === 'string' && ARCHIVE_NAME.test(wanted) ? wanted.slice(0, 60) : new Date().toISOString().slice(0, 10);
  const taken = new Set((await q.query('select archived_as from cycle where project_id = $1 and user_id = $2 and not is_live', [projectId, userId])).rows.map((r) => r.archived_as));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * A push is a one-shot read, so every push dates a standing problem "since just now". The server has
 * seen the earlier pushes: keep the first date. Without this the date moves on every push, the model's
 * version with it, and every open page repaints for a push that changed nothing.
 */
function sinceFirstSeen(payload, previous) {
  const first = new Map((previous?.problems ?? []).filter((p) => p?.since).map((p) => [`${p.code}|${p.subject}`, p.since]));
  if (!first.size) return payload;
  return { ...payload, problems: payload.problems.map((p) => (first.has(`${p.code}|${p.subject}`) ? { ...p, since: first.get(`${p.code}|${p.subject}`) } : p)) };
}

/** The batches whose pull request URL this push brings for the first time: what to tell the developer about. */
export function newPullRequests(payload, previous) {
  const before = previous?.batchFiles ?? {};
  const opened = [];
  for (const [batchKey, file] of Object.entries(payload.batchFiles ?? {})) {
    const prUrl = file?.data?.pr_url;
    if (typeof prUrl === 'string' && /^https:\/\//.test(prUrl) && before[batchKey]?.data?.pr_url !== prUrl) opened.push({ batchKey, prUrl });
  }
  return opened;
}

/**
 * @returns {Promise<{cycleUuid: string, changed: boolean, missing: string[], archived: string|null, prOpened: {batchKey: string, prUrl: string}[]}>}
 */
export async function ingestCycle(db, { projectId, userId, payload }) {
  validatePayload(payload);
  const hash = canonicalHash(payload);
  const manifest = [...manifestOf(payload).keys()];
  const { cycle } = payload;

  return db.tx(async (q) => {
    // The membership row is the lock: two laptops pushing new cycles for one developer take turns here,
    // instead of meeting at the one-live-cycle index.
    const member = await q.query('select role from membership where project_id = $1 and user_id = $2 for update', [projectId, userId]);
    if (!member.rowCount) throw fail(404, 'No such project.');
    if (!PUSHERS.has(member.rows[0].role)) throw fail(403, 'Only a developer of this project can push a cycle.');

    const existing = (await q.query('select project_id, user_id, is_live, payload_sha256, snapshot from cycle where id = $1 for update', [cycle.id])).rows[0];
    // Someone else's cycle id answers exactly like an unknown project: its existence is not ours to confirm.
    if (existing && (existing.project_id !== projectId || String(existing.user_id) !== String(userId))) throw fail(404, 'No such project.');
    if (existing && !existing.is_live) throw fail(409, 'This cycle was archived on the server. Start a new one with /taskflow:triage.');

    let changed = true;
    let archived = null;
    const stored = JSON.stringify(sinceFirstSeen(payload, existing?.snapshot));
    if (existing) {
      changed = existing.payload_sha256 !== hash;
      await q.query(
        `update cycle set snapshot = $2, payload_sha256 = $3, last_triage = $4, dev_head = $5, pushed_at = now(), pushed_from = $6, rev = rev + $7
         where id = $1 and project_id = $8 and user_id = $9`,
        [cycle.id, stored, hash, cycle.lastTriage, cycle.devHead, payload.pushedFrom ?? null, changed ? 1 : 0, projectId, userId],
      );
    } else {
      const live = (await q.query('select id, last_triage from cycle where project_id = $1 and user_id = $2 and is_live for update', [projectId, userId])).rows[0];
      if (live) {
        // A new cycle id means /taskflow:clean ran. Whether or not it told us, the old cycle is history now.
        archived = await archiveName(q, { projectId, userId, wanted: live.last_triage });
        await q.query('update cycle set is_live = false, archived_as = $2 where id = $1', [live.id, archived]);
      }
      await q.query(
        `insert into cycle (id, project_id, user_id, is_live, last_triage, dev_head, snapshot, payload_sha256, pushed_from)
         values ($1, $2, $3, true, $4, $5, $6, $7, $8)`,
        [cycle.id, projectId, userId, cycle.lastTriage, cycle.devHead, stored, hash, payload.pushedFrom ?? null],
      );
    }

    if (changed) {
      await q.query('delete from cycle_blob where cycle_id = $1', [cycle.id]);
      if (manifest.length) await q.query('insert into cycle_blob (cycle_id, project_id, sha256) select $1, $2, h from unnest($3::text[]) as h on conflict do nothing', [cycle.id, projectId, manifest]);
      await q.query('insert into audit_log (user_id, project_id, action, payload) values ($1, $2, $3, $4)', [userId, projectId, 'push',
        JSON.stringify({ cycle: cycle.id, from: payload.pushedFrom ?? null, archived })]);
    }

    const missing = manifest.length
      ? (await q.query('select h from unnest($2::text[]) as h where not exists (select 1 from blob where project_id = $1 and sha256 = h)', [projectId, manifest])).rows.map((r) => r.h)
      : [];
    // Only against a cycle the server already held: the first push of a cycle brings history, not news.
    return { cycleUuid: cycle.id, changed, missing, archived, prOpened: existing ? newPullRequests(payload, existing.snapshot) : [] };
  });
}

/**
 * @param {Buffer} input.body
 * @returns {Promise<{stored: boolean}>} false when the project already held it
 */
export async function putBlob(db, { projectId, sha256: claimed, body }) {
  if (!Buffer.isBuffer(body)) throw fail(400, 'A blob is bytes.');
  if (body.length > MAX_BLOB_BYTES) throw fail(413, `Too large: ${body.length} bytes, ${MAX_BLOB_BYTES} at most.`);
  // The name is a claim about the content. Check it, or one upload could stand in for any file.
  if (sha256(body) !== claimed) throw fail(400, 'The content does not match its hash.');

  return db.tx(async (q) => {
    // Only what a pushed cycle of this project asked for: the store is not a general-purpose bucket.
    const wanted = await q.query('select 1 from cycle_blob where project_id = $1 and sha256 = $2 limit 1', [projectId, claimed]);
    if (!wanted.rowCount) throw fail(404, 'No pushed cycle of this project refers to that blob.');

    const inserted = await q.query('insert into blob (project_id, sha256, size, body) values ($1, $2, $3, $4) on conflict do nothing', [projectId, claimed, body.length, body]);
    // The page shows "the last push did not finish" until this arrives, so its arrival must repaint it.
    if (inserted.rowCount) await q.query('update cycle set rev = rev + 1 where id in (select cycle_id from cycle_blob where project_id = $1 and sha256 = $2)', [projectId, claimed]);
    return { stored: inserted.rowCount === 1 };
  });
}
