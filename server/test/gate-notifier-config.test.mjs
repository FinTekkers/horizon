// HZ-141 success metrics 5 and 6, plus guardrails 4, 5 and 6.
//
//   metric 5.    "The approver chat comes from configuration. Test asserts no
//                chat id literal in source."
//   metric 6.    "No model call occurs on the notification path."
//   guardrail 4. no work-item content to any service other than the existing
//                WhatsApp bridge — which also means no credential belonging to
//                another service is read here (not FARM_SHARED_SECRET, and not
//                HZ-140's WA_APPROVAL_SECRET, which is the inbound approval
//                route's and has no business on an outbound path).
//   guardrail 5. no hardcoded chat ids or phone numbers.
//   guardrail 6. do not change the concierge's behaviour — asserted here as
//                "no server/src file on this path reaches into it", and from the
//                other side by farm/tests/test_concierge_ignores_gate_notice.py,
//                which pins the concierge's existing ingestion behaviour intact.
//
// Metric 5 has two halves and both are here, because either alone is weak: a
// literal scan says nothing about where the value actually comes from, and a
// "it reads the env var" test says nothing about a literal sitting beside it.
//
// SCOPE OF THE LITERAL SCAN, and why — this is the part QA's review was right
// to flag, because the obvious scan is RED against code that predates this item:
//
//   * server/src/** is scanned for BOTH a jid pattern and a bare 10+ digit run.
//     This is the production tree this item adds to, and it is clean.
//   * farm/ non-test source is scanned for the JID pattern only. Its two bare
//     digit-run hits are PROSE, both pre-existing and both correct to keep:
//     farm/concierge_agent.py's normalize_jid docstring and farm/config.py's
//     FARM_WA_SENDER_NAMES example. stripComments() cannot blank the first —
//     it is a `"""` docstring, not a `#` comment — so widening the digit clause
//     to farm/ would mean either deleting useful documentation or adding a
//     per-file waiver, and neither buys anything: a jid is what actually routes
//     a message, and that clause covers farm/ in full.
//   * test trees are NOT scanned. Every jid literal in the repo lives in one
//     (farm/tests/, server/test/) and has to: a test that cannot name a
//     recipient cannot assert who was messaged. HZ-140 added several and this
//     item adds more.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { REPO_ROOT, repoFiles, relative, stripComments, MIN_EXPECTED_FILES } from './helpers/repoFiles.mjs'

// Set before the waApprovers import below, which snapshots the list at load.
// Two jids so the same-list assertion iterates something rather than passing on
// an empty array.
process.env.WA_APPROVER_JIDS = '15559990001@s.whatsapp.net,15559990002:7@s.whatsapp.net'

const JID_LITERAL = /[0-9]{7,15}@(s\.whatsapp\.net|g\.us)/
const BARE_PHONE = /(^|[^0-9.])[0-9]{10,}([^0-9]|$)/

const files = repoFiles()
const rel = files.map((f) => relative(f))

const isTestFile = (p) =>
  p.startsWith('server/test/') || p.startsWith('farm/tests/') || p.startsWith('e2e/') || /\.test\.[a-z]+$/.test(p)

const serverSrc = rel.filter((p) => p.startsWith('server/src/'))
const farmSrc = rel.filter((p) => p.startsWith('farm/') && p.endsWith('.py') && !isTestFile(p))

function code(relPath) {
  return stripComments(readFileSync(path.join(REPO_ROOT, relPath), 'utf8'))
}

test('the scan is not vacuous: the walk found the tree and both scoped sets are populated', () => {
  assert.ok(files.length >= MIN_EXPECTED_FILES, `walk visited only ${files.length} file(s)`)
  assert.ok(serverSrc.includes('server/src/gateNotifier.js'))
  assert.ok(serverSrc.includes('server/src/waSend.js'))
  assert.ok(serverSrc.includes('server/src/waApprovers.js'))
  assert.ok(farmSrc.includes('farm/whatsapp/mcp_bridge.py'))
  // Positive control on the patterns themselves: they DO fire, on a test file
  // that legitimately names a recipient. A broken regex would pass every
  // "no hits" assertion below.
  const fixture = code('server/test/gate-notifier.test.mjs')
  assert.match(fixture, JID_LITERAL, 'JID_LITERAL matches nothing — it cannot be working')
  assert.match(fixture, BARE_PHONE, 'BARE_PHONE matches nothing — it cannot be working')
})

test('no jid literal in server/src or in non-test farm source (guardrail 5)', () => {
  const hits = [...serverSrc, ...farmSrc].filter((p) => JID_LITERAL.test(code(p)))
  assert.deepEqual(hits, [], `a WhatsApp jid is hardcoded in: ${hits.join(', ')}`)
})

test('no bare phone-number literal anywhere in server/src (guardrail 5)', () => {
  const hits = serverSrc.filter((p) => BARE_PHONE.test(code(p)))
  assert.deepEqual(hits, [], `a phone number looks hardcoded in: ${hits.join(', ')}`)
})

// ---- metric 5, the other half: the recipients really come from config ----
// WA_APPROVER_JIDS is read once at module load, so each case needs its own
// process. The child reports what the sweep enqueued and to whom.

function sweepWithApprovers(approverJids) {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-gatenotify-cfg-')), 'test.db')
  const script = `
    const { db } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/db.js'))})
    const { sweepGates } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/gateNotifier.js'))})
    const { gateStepIndexes } = await import(${JSON.stringify(path.join(REPO_ROOT, 'domain/js/lifecycle.js'))})
    db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
      .run('T-CFG', 'Config-driven recipients', 'High', gateStepIndexes()[0])
    const result = sweepGates()
    const recipients = db.prepare('SELECT recipient FROM gate_notice ORDER BY id').all().map((r) => r.recipient)
    console.log(JSON.stringify({ ...result, recipients }))
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HORIZON_DB: dbPath, WA_APPROVER_JIDS: approverJids },
  })
  assert.equal(res.status, 0, `child failed:\n${res.stdout}${res.stderr}`)
  return JSON.parse(res.stdout.trim().split('\n').at(-1))
}

test('an empty WA_APPROVER_JIDS enqueues nothing — HZ-140 deny-all means notify-nobody', () => {
  const out = sweepWithApprovers('')
  assert.equal(out.enqueued, 0)
  assert.deepEqual(out.recipients, [])
})

test('the configured jid is the recipient, verbatim — server part intact so the bridge can route it', () => {
  const out = sweepWithApprovers('15559990001@s.whatsapp.net')
  assert.equal(out.enqueued, 1)
  assert.deepEqual(out.recipients, ['15559990001@s.whatsapp.net'])
})

test('two configured approvers get one notification each, in configured order', () => {
  const out = sweepWithApprovers('15559990001@s.whatsapp.net, 15559990002@s.whatsapp.net')
  assert.equal(out.enqueued, 2)
  assert.deepEqual(out.recipients, ['15559990001@s.whatsapp.net', '15559990002@s.whatsapp.net'])
})

test('notification recipients and gate approvers are the SAME list — no parallel setting exists', async () => {
  const approvers = await import('../src/waApprovers.js')
  const jids = approvers.approverJids()
  assert.equal(jids.length, 2, 'the fixture must configure approvers or this loop asserts nothing')
  // Including one carrying a device suffix, which approverJids() must NOT strip
  // (the bridge needs the full jid to route) while isAllowedApprover still
  // matches it via normalizeJid.
  assert.ok(jids.some((j) => j.includes(':')))
  for (const jid of jids) {
    assert.ok(approvers.isAllowedApprover(jid), `${jid} would be notified but could not approve`)
  }
  // Structural: config.js declares no second recipient list.
  const cfg = code('server/src/config.js')
  assert.ok(!/WA_NOTIFY_(CHAT|JIDS|RECIPIENTS)/.test(cfg), 'a parallel notify-recipient setting was added')
})

// ---- metric 6 and guardrails 3/4, statically ----

const NOTIFIER_SOURCE = {
  'server/src/gateNotifier.js': code('server/src/gateNotifier.js'),
  'server/src/waSend.js': code('server/src/waSend.js'),
}

test('the notification path imports nothing from the agent/farm path (metric 6)', () => {
  for (const [file, src] of Object.entries(NOTIFIER_SOURCE)) {
    for (const forbidden of ['orchestrator.js', 'personas.js', 'agentTokens.js', 'github.js', 'deploy.js']) {
      assert.ok(!src.includes(forbidden), `${file} reaches into ${forbidden}`)
    }
    // run_agent is Python (farm/agent_runner.py); the Node-side equivalents are
    // store.registerAgentRunner's kick/cancel. Neither name may appear.
    for (const forbidden of ['run_agent', 'registerAgentRunner', 'agentRunner', 'kick(']) {
      assert.ok(!src.includes(forbidden), `${file} mentions ${forbidden}`)
    }
  }
  // Positive control: the scan is reading real source.
  assert.ok(NOTIFIER_SOURCE['server/src/gateNotifier.js'].includes('sweepGates'))
})

test('the notification path reads no credential and no other service URL (guardrail 4)', () => {
  for (const [file, src] of Object.entries(NOTIFIER_SOURCE)) {
    for (const forbidden of ['FARM_SHARED_SECRET', 'WA_APPROVAL_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'SESSION_SECRET']) {
      assert.ok(!src.includes(forbidden), `${file} reads ${forbidden} — it has no business on this path`)
    }
  }
  // The only outbound URL anywhere on the path is the bridge's.
  const urls = [...NOTIFIER_SOURCE['server/src/waSend.js'].matchAll(/fetchImpl\(([^)]*)/g)].map((m) => m[1])
  assert.equal(urls.length, 1, 'waSend.js makes more than one outbound call')
  assert.match(urls[0], /WA_BRIDGE_URL/)
  // gateNotifier.js makes no network call at all — it delegates to waSend.js.
  assert.ok(!/\bfetch\s*\(/.test(NOTIFIER_SOURCE['server/src/gateNotifier.js']))
})

test('nothing on the notification path reaches the concierge (guardrail 6)', () => {
  for (const [file, src] of Object.entries(NOTIFIER_SOURCE)) {
    for (const forbidden of ['concierge', 'mcp_bridge', 'FARM_WA_', 'command_chats']) {
      assert.ok(!src.includes(forbidden), `${file} reaches into the concierge via ${forbidden}`)
    }
  }
  // And this item adds no production file under farm/ at all — the concierge's
  // process is not involved in sending a notification.
  const farmAdditions = rel.filter((p) => p.startsWith('farm/') && /gate.?notif|gateNotifier/i.test(p) && !isTestFile(p))
  assert.deepEqual(farmAdditions, [], `HZ-141 added farm/ production code: ${farmAdditions.join(', ')}`)
})

test('init() is a no-op when WA_NOTIFY_ENABLED is not "1" — and e2e pins it off', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-gatenotify-off-')), 'test.db')
  const script = `
    const { db } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/db.js'))})
    const notifier = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/gateNotifier.js'))})
    const store = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/store.js'))})
    const { gateStepIndexes } = await import(${JSON.stringify(path.join(REPO_ROOT, 'domain/js/lifecycle.js'))})
    db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
      .run('T-OFF', 'Notifier is off', 'High', gateStepIndexes()[0])
    notifier.init({ info: () => {}, warn: () => {}, error: () => {} })
    store.notifyChange()   // would fire the sweep if init() had subscribed
    await new Promise((r) => setImmediate(r))
    console.log(JSON.stringify({ queued: db.prepare('SELECT COUNT(*) AS n FROM gate_notice').get().n }))
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HORIZON_DB: dbPath, WA_APPROVER_JIDS: '15559990001@s.whatsapp.net', WA_NOTIFY_ENABLED: '0' },
  })
  assert.equal(res.status, 0, `child failed:\n${res.stdout}${res.stderr}`)
  assert.deepEqual(JSON.parse(res.stdout.trim().split('\n').at(-1)), { queued: 0 })

  // The e2e suite drives demo items onto gates by design, so the flag being
  // pinned off in its webServer env is the thing that stops a suite run texting
  // a real human (QA review, blocking).
  const e2eConfig = readFileSync(path.join(REPO_ROOT, 'e2e/playwright.config.js'), 'utf8')
  assert.match(e2eConfig, /WA_NOTIFY_ENABLED:\s*'0'/)
  assert.match(e2eConfig, /WA_BRIDGE_URL:\s*''/)
})
