import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { MIGRATIONS_DIR, migrate, readMigrations } from '../migrate.mjs';
import { testDb } from './helpers/db.mjs';

const FIRST = '001_core.sql';

async function scratchMigrations(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'taskflow-migrations-'));
  await copyFile(join(MIGRATIONS_DIR, FIRST), join(dir, FIRST));
  for (const [name, sql] of Object.entries(extra)) await writeFile(join(dir, name), sql);
  return dir;
}

const tables = async (db) => (await db.query('select table_name from information_schema.tables where table_schema = current_schema() order by 1')).rows.map((r) => r.table_name);

test('a fresh database gets every table; a second boot has nothing to do', async () => {
  const t = await testDb({ migrated: false });
  try {
    const expected = (await readMigrations()).map((m) => m.file);
    assert.deepEqual(await migrate(t.db), expected);
    assert.deepEqual(await tables(t.db), ['answer', 'api_token', 'app_user', 'audit_log', 'blob', 'claim', 'cycle', 'cycle_blob', 'inbox_tick', 'invite', 'job', 'job_event', 'job_question', 'machine', 'membership', 'project', 'question_state', 'schema_migrations', 'session']);
    assert.deepEqual(await migrate(t.db), []);
  } finally {
    await t.close();
  }
});

test('two servers booting at once take turns; each migration is applied once', async () => {
  const t = await testDb({ migrated: false });
  try {
    const results = await Promise.all([migrate(t.db), migrate(t.open()), migrate(t.open())]);
    assert.equal(results.flat().length, (await readMigrations()).length, 'applied once in total, whoever got there first');
    assert.equal((await t.db.query('select count(*)::int as n from schema_migrations')).rows[0].n, (await readMigrations()).length);
  } finally {
    await t.close();
  }
});

describe('what the runner refuses to boot on', () => {
  test('an applied migration whose file changed', async () => {
    const t = await testDb({ migrated: false });
    const dir = await scratchMigrations();
    try {
      await migrate(t.db, { dir });
      await writeFile(join(dir, FIRST), `${await readFile(join(dir, FIRST), 'utf8')}\n-- a harmless-looking edit\n`);
      await assert.rejects(migrate(t.db, { dir }), /changed after it was applied/);
    } finally {
      await t.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('but not on line endings, which differ by checkout', async () => {
    const t = await testDb({ migrated: false });
    const dir = await scratchMigrations();
    try {
      await migrate(t.db, { dir });
      await writeFile(join(dir, FIRST), (await readFile(join(dir, FIRST), 'utf8')).replace(/\n/g, '\r\n'));
      assert.deepEqual(await migrate(t.db, { dir }), []);
    } finally {
      await t.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a gap in the numbering', async () => {
    const dir = await scratchMigrations({ '003_later.sql': 'select 1;' });
    try {
      await assert.rejects(readMigrations(dir), /without gaps/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a database that is newer than the code', async () => {
    const t = await testDb({ migrated: false });
    const newer = await scratchMigrations({ '002_later.sql': 'create table later (id integer primary key);' });
    const older = await scratchMigrations();
    try {
      await migrate(t.db, { dir: newer });
      await assert.rejects(migrate(t.db, { dir: older }), /newer than this code/);
    } finally {
      await t.close();
      await rm(newer, { recursive: true, force: true });
      await rm(older, { recursive: true, force: true });
    }
  });

  test('a migration that fails leaves nothing behind, and says so', async () => {
    const t = await testDb({ migrated: false });
    const dir = await scratchMigrations({ '002_broken.sql': 'create table half (id integer primary key); select * from nowhere;' });
    try {
      await assert.rejects(migrate(t.db, { dir }), /nowhere/);
      assert.ok(!(await tables(t.db)).includes('half'), 'the half-applied migration was rolled back');
      assert.deepEqual((await t.db.query('select version from schema_migrations')).rows, [{ version: 1 }]);
    } finally {
      await t.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('no migration names a schema, an enum type or an extension: tests run them inside throwaway schemas', async () => {
  for (const name of await readdir(MIGRATIONS_DIR)) {
    const sql = (await readFile(join(MIGRATIONS_DIR, name), 'utf8')).replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /\bpublic\./i, `${name} names the public schema`);
    assert.doesNotMatch(sql, /create\s+type\b/i, `${name} creates a type`);
    assert.doesNotMatch(sql, /create\s+extension\b/i, `${name} needs an extension`);
    assert.doesNotMatch(sql, /\bjsonb\b/i, `${name} uses jsonb, which reorders object keys`);
  }
});

test('the schema option is a name, never SQL', async () => {
  const { createDb } = await import('../db.mjs');
  assert.throws(() => createDb('postgres://x/y', { schema: 'a; drop schema public' }), /Not a usable schema name/);
  assert.throws(() => createDb('postgres://x/y', { schema: 'Public' }), /Not a usable schema name/);
  assert.throws(() => createDb(''), /No database URL/);
});
