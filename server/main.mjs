#!/usr/bin/env node
// Entry point of the hosted dashboard.
//
//   DATABASE_URL=postgres://... PUBLIC_URL=http://127.0.0.1:3900 node server/main.mjs
//
// Checks its configuration, brings the database up to date, then serves.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostedApp } from './app.mjs';
import { readConfig } from './config.mjs';
import { createDb } from './db.mjs';
import { migrate } from './migrate.mjs';

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? 'dev';
  } catch {
    return 'dev';
  }
}

let config;
try {
  config = readConfig(process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const db = createDb(config.databaseUrl);
try {
  for (const file of await migrate(db)) console.log(`Applied ${file}`);
} catch (error) {
  console.error(`The database could not be brought up to date: ${error.message}`);
  await db.close().catch(() => {});
  process.exit(1);
}

// Without sign-in configured nobody can be signed in, so every write is refused before its body is read.
const app = createHostedApp({ db, publicUrl: config.publicUrl, version: pluginVersion(), auth: config.auth, trustProxy: config.trustProxy, push: config.push });
await app.listen(config.bind);
console.log(`Taskflow dashboard: ${config.publicUrl.origin} on ${config.bind.host}:${config.bind.port}${config.auth ? '' : ' (no sign-in configured: loopback only, read-only)'}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
