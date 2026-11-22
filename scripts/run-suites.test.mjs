// HZ-952: scripts/run-suites.mjs keeps running suites after one fails, lists
// the failed ones by name, passes output through unchanged and stops at once
// on Ctrl-C. Stub suites are plain `sh` one-liners writing marker files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSuite } from './run-suites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'run-suites.mjs');
const REPO_ROOT = path.resolve(HERE, '..');

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hz952-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stubEnv(dir) {
  const env = { ...process.env, DIR: dir, TMPDIR: dir };
  delete env.FARM_HOME;
  return env;
}

function run(dir, suites) {
  return spawnSync(process.execPath, [RUNNER, ...suites], {
    env: stubEnv(dir),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function failedList(stdout) {
  const at = stdout.indexOf('Failed suites:\n');
  return at === -1 ? null : stdout.slice(at + 'Failed suites:\n'.length);
}

test('metric 1: a failing first suite does not stop the next two', (t) => {
  const dir = scratch(t);
  run(dir, [
    'alpha: echo > "$DIR/alpha"; exit 1',
    'bravo: echo > "$DIR/bravo"',
    'charlie: echo > "$DIR/charlie"',
  ]);
  assert.ok(existsSync(path.join(dir, 'alpha')));
  assert.ok(existsSync(path.join(dir, 'bravo')));
  assert.ok(existsSync(path.join(dir, 'charlie')));
});

test('metric 2: one failing suite exits non-zero; all passing exits 0 with no failed list', (t) => {
  const dir = scratch(t);
  const red = run(dir, ['alpha: true', 'bravo: exit 1', 'charlie: true']);
  assert.notEqual(red.status, 0, red.stderr);
  const green = run(dir, ['alpha: true', 'bravo: true', 'charlie: true']);
  assert.equal(green.status, 0, green.stderr);
  assert.doesNotMatch(green.stdout, /Failed suites:/);
});

test('metric 3: the failed list names each failed suite and no passing one', (t) => {
  const dir = scratch(t);
  const result = run(dir, ['alpha: exit 1', 'bravo: true', 'charlie: true']);
  const list = failedList(result.stdout);
  assert.notEqual(list, null, result.stdout);
  assert.match(list, /alpha/);
  assert.doesNotMatch(list, /bravo/);
  assert.doesNotMatch(list, /charlie/);
});

test('metric 4: a failed install fails its suite by name and the next suite still runs', (t) => {
  const dir = scratch(t);
  writeFileSync(path.join(dir, 'stub-install.sh'), 'exit 1\n');
  const result = run(dir, [
    'alpha: true',
    'bravo: sh "$DIR/stub-install.sh" && echo > "$DIR/bravo-test"',
    'charlie: echo > "$DIR/charlie"',
  ]);
  assert.notEqual(result.status, 0);
  const list = failedList(result.stdout);
  assert.notEqual(list, null, result.stdout);
  assert.match(list, /bravo/);
  assert.ok(!existsSync(path.join(dir, 'bravo-test')));
  assert.ok(existsSync(path.join(dir, 'charlie')));
});

// Splits the root `test` script on spaces outside double quotes. The script
// only uses plain double quotes, with no escapes inside them.
function shellSplit(script) {
  const words = [];
  let word = null;
  let quoted = false;
  for (const ch of script) {
    if (ch === '"') {
      quoted = !quoted;
      word ??= '';
    } else if (ch === ' ' && !quoted) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + ch;
    }
  }
  assert.equal(quoted, false, 'unbalanced quote in the root test script');
  if (word !== null) words.push(word);
  return words;
}

test('guardrail 1: the root test script runs every suite of the old chain, in its order', () => {
  const script = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts.test;
  const [node, runner, ...args] = shellSplit(script);
  assert.equal(`${node} ${runner}`, 'node scripts/run-suites.mjs');
  const suites = args.map(parseSuite);
  // The chain before HZ-952, one suite per entry.
  assert.deepEqual(suites, [
    { name: 'server', command: 'npm --prefix farm/capture install --no-audit --no-fund && npm --prefix server install --no-audit --no-fund && npm --prefix server test' },
    { name: 'ui', command: 'npm --prefix ui install --no-audit --no-fund && npm --prefix ui run test' },
    { name: 'shell', command: 'bash infra/host/test/run-all.sh' },
    { name: 'whatsapp-bridge', command: 'bash infra/whatsapp-bridge/run-checks.sh' },
    { name: 'ensure-build', command: 'node --test ui/scripts/ensure-build.test.mjs' },
    { name: 'verify-base-build', command: 'node ui/scripts/verify-base-build.mjs' },
    { name: 'recorder', command: 'npm --prefix scripts/recorder install --no-audit --no-fund && npm --prefix scripts/recorder test' },
    { name: 'tenant-sites', command: 'npm --prefix scripts/tenant-sites test' },
    { name: 'parvati-site', command: 'npm --prefix scripts/tenant-sites/parvati-site test' },
    { name: 'runner', command: 'node --test scripts/run-suites.test.mjs' },
  ]);
});

test('guardrail 1: suites run one at a time, in argument order', (t) => {
  const dir = scratch(t);
  const stub = (name) => `${name}: echo ${name}-start >> "$DIR/log"; echo ${name}-end >> "$DIR/log"`;
  const result = run(dir, [stub('alpha'), stub('bravo'), stub('charlie')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(path.join(dir, 'log'), 'utf8'),
    'alpha-start\nalpha-end\nbravo-start\nbravo-end\ncharlie-start\ncharlie-end\n',
  );
});

test('guardrail 2: suite stdout and stderr pass through unchanged', (t) => {
  const dir = scratch(t);
  const green = run(dir, ['alpha: echo "alpha out [1]"; echo "alpha err [2]" >&2']);
  assert.equal(green.stdout, 'alpha out [1]\n');
  assert.equal(green.stderr, 'alpha err [2]\n');
  const red = run(dir, ['alpha: echo "alpha out [1]"; echo "alpha err [2]" >&2; exit 1']);
  assert.equal(red.stdout, 'alpha out [1]\nFailed suites:\n  - alpha\n');
  assert.equal(red.stderr, 'alpha err [2]\n');
});

test('guardrail 3: the runner imports only Node built-ins', () => {
  const source = readFileSync(RUNNER, 'utf8');
  const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.ok(specifier.startsWith('node:'), specifier);
});

test('guardrail 4: a suite killed by SIGINT stops the run with 130', (t) => {
  const dir = scratch(t);
  const result = run(dir, ['alpha: kill -INT $$', 'bravo: echo > "$DIR/bravo"']);
  assert.equal(result.status, 130, result.stderr);
  assert.ok(!existsSync(path.join(dir, 'bravo')));
});

async function signalGroup(t, signal) {
  const dir = scratch(t);
  const started = path.join(dir, 'started');
  const child = spawn(
    process.execPath,
    [RUNNER, 'alpha: echo > "$DIR/started"; sleep 30', 'bravo: echo > "$DIR/bravo"'],
    { env: stubEnv(dir), detached: true, stdio: 'ignore' },
  );
  const closed = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, sig })));
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(started)) {
    assert.ok(Date.now() < deadline, 'alpha never started');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const sentAt = Date.now();
  process.kill(-child.pid, signal);
  const { code, sig } = await closed;
  return { code, sig, elapsed: Date.now() - sentAt, bravoRan: existsSync(path.join(dir, 'bravo')) };
}

test('guardrail 4: SIGINT to the run\'s process group exits 130 at once and starts nothing more', async (t) => {
  const { code, sig, elapsed, bravoRan } = await signalGroup(t, 'SIGINT');
  assert.equal(code, 130, `signal ${sig}`);
  assert.ok(elapsed < 5_000, `took ${elapsed} ms`);
  assert.equal(bravoRan, false);
});

test('guardrail 4: SIGTERM to the run\'s process group exits 143 at once and starts nothing more', async (t) => {
  const { code, sig, elapsed, bravoRan } = await signalGroup(t, 'SIGTERM');
  assert.equal(code, 143, `signal ${sig}`);
  assert.ok(elapsed < 5_000, `took ${elapsed} ms`);
  assert.equal(bravoRan, false);
});
