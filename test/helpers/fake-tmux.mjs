#!/usr/bin/env node
// A stand-in for `tmux`, for the runner's tests. Records what it was asked to start in
// FAKE_TMUX_LOG and plays a pane back for capture-pane.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const log = process.env.FAKE_TMUX_LOG;
const command = argv[0];

if (command === 'has-session') {
  // The window exists once new-session was recorded for that name.
  const name = argv[argv.indexOf('-t') + 1];
  const known = log && existsSync(log) && readFileSync(log, 'utf8').split('\n').some((line) => line.includes(` -s ${name} `));
  process.exit(known ? 0 : 1);
}
if (command === 'new-session') {
  if (log) appendFileSync(log, `${argv.join(' ')}\n`);
  process.exit(0);
}
if (command === 'capture-pane') {
  process.stdout.write('Remote Control is on. Open this session in the Claude app.\nhttps://claude.ai/code/remote/fake-pairing\n');
  process.exit(0);
}
process.stderr.write(`fake tmux: unknown command ${command}\n`);
process.exit(2);
