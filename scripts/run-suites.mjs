#!/usr/bin/env node
// HZ-952: runs the root `npm test` suites one after another and keeps going
// after a failure, so one run shows every failing suite, not just the first.
//
//   node scripts/run-suites.mjs "<name>: <command>" ...
//
// Each command runs through `sh -c` with the terminal's stdio, so its output
// is exactly what it was in the old `&&` chain. Install and test steps share
// one argument joined by `&&`, so a failed `npm install` fails that suite.
// At the end the failed suites are listed under `Failed suites:` and the run
// exits 1; a green run adds no output and exits 0.
//
// Ctrl-C (SIGINT) or SIGTERM stops the whole run at once: the signal goes to
// the running suite, and no further suite starts. Exit is 130 / 143.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const STOP_STATUS = { SIGINT: 130, SIGTERM: 143 };

// Split at the first ": " — suite names never hold one, and commands may
// (a later ": " stays in the command).
export function parseSuite(arg) {
  const at = arg.indexOf(': ');
  const name = at === -1 ? '' : arg.slice(0, at).trim();
  const command = at === -1 ? '' : arg.slice(at + 2).trim();
  if (!name || !command) {
    throw new Error(`run-suites: expected "<name>: <command>", got ${JSON.stringify(arg)}`);
  }
  return { name, command };
}

function runOne(command, state) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { stdio: 'inherit' });
    state.child = child;
    child.on('error', (err) => {
      process.stderr.write(`run-suites: ${err.message}\n`);
      state.child = null;
      resolve({ code: 1, signal: null });
    });
    child.on('close', (code, signal) => {
      state.child = null;
      resolve({ code, signal });
    });
  });
}

async function runSuites(suites) {
  const state = { child: null, stoppedBy: null };
  const onSignal = (signal) => {
    state.stoppedBy ??= STOP_STATUS[signal];
    if (state.child && state.child.exitCode === null && state.child.signalCode === null) {
      state.child.kill(signal);
    }
  };
  const handlers = Object.keys(STOP_STATUS).map((signal) => {
    const handler = () => onSignal(signal);
    process.on(signal, handler);
    return [signal, handler];
  });

  const failed = [];
  try {
    for (const { name, command } of suites) {
      if (state.stoppedBy !== null) break;
      const { code, signal } = await runOne(command, state);
      if (Object.hasOwn(STOP_STATUS, signal ?? '')) {
        state.stoppedBy ??= STOP_STATUS[signal];
      } else if (code === 130 || code === 143) {
        state.stoppedBy ??= code;
      }
      if (state.stoppedBy !== null) break;
      if (code !== 0) failed.push(name);
    }
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  return { failed, stoppedBy: state.stoppedBy };
}

async function main(args) {
  let suites;
  try {
    suites = args.map(parseSuite);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const { failed, stoppedBy } = await runSuites(suites);
  if (stoppedBy !== null) return stoppedBy;
  if (failed.length === 0) return 0;
  process.stdout.write(`Failed suites:\n${failed.map((name) => `  - ${name}\n`).join('')}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
