// BOT_MARKER now exists in two languages, and this file is the price of that.
//
// HZ-141 put the gate notifier in Node, because the cursor it watches is Node
// state. The concierge's transport is Python. Both prefix outbound messages with
// the same marker, and the marker is load-bearing in ONE direction only: the
// bridge's inbound filter (farm/whatsapp/mcp_bridge.py's fetch_new) skips
// marker-prefixed text, which is what stops the concierge reacting to a
// notification the server sent. If the two constants drift, the JS side keeps
// sending happily and the Python side stops recognising its own outbound
// messages — a silent echo loop, not a crash.
//
// The alternative was routing the send through the farm, which would have meant
// two new Node endpoints and a new shared secret on a path that currently needs
// none. This test is the cheaper half of that trade, and this comment is why.
//
// The full chain metric 7 rests on, stated in one place:
//   1. HERE — the two constants are byte-equal.
//   2. gate-notifier-retry.test.mjs — the Node wire payload carries the marker
//      exactly once, prefixed by waSend.js and by nothing else.
//   3. farm/tests/test_concierge_ignores_gate_notice.py — a marker-prefixed body
//      is not ingested, in every chat kind the bridge would otherwise accept.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { BOT_MARKER } from '../src/waSend.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

// Imported through a real python3 rather than regex-scraped out of the source:
// the two files spell the same codepoint differently on purpose (JS
// '\u{1F916} ', Python '\U0001F916 '), so a textual comparison would fail on
// two constants that are in fact identical.
function pythonBotMarker() {
  const out = execFileSync(
    'python3',
    ['-c', 'import json; from farm.whatsapp.mcp_bridge import BOT_MARKER; print(json.dumps(BOT_MARKER))'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  return JSON.parse(out)
}

test('the JS and Python bot markers are byte-equal', () => {
  const py = pythonBotMarker()
  assert.equal(BOT_MARKER, py, `JS ${JSON.stringify(BOT_MARKER)} !== Python ${JSON.stringify(py)}`)
  assert.deepEqual([...Buffer.from(BOT_MARKER, 'utf8')], [...Buffer.from(py, 'utf8')])
})

test('the marker is the robot face plus one trailing space — the prefix the bridge filter matches', () => {
  assert.equal(BOT_MARKER, '\u{1F916} ')
  assert.equal([...BOT_MARKER].length, 2)
  assert.ok(BOT_MARKER.endsWith(' '), 'without the space the marker runs into the message text')
})

test('each language declares the marker exactly once — no third copy has appeared', () => {
  const jsFiles = ['server/src/waSend.js', 'server/src/gateNotifier.js', 'server/src/store.js', 'server/src/app.js']
  const declaring = jsFiles.filter((f) => /BOT_MARKER\s*=/.test(readFileSync(path.join(REPO_ROOT, f), 'utf8')))
  assert.deepEqual(declaring, ['server/src/waSend.js'], 'BOT_MARKER is declared somewhere it should not be')
  const py = readFileSync(path.join(REPO_ROOT, 'farm/whatsapp/mcp_bridge.py'), 'utf8')
  assert.equal((py.match(/^BOT_MARKER = /gm) || []).length, 1)
})

// WA_BRIDGE_URL is the other name now shared across the two languages. Same env
// var, read independently: farm/config.py holds it verbatim and BridgeTransport
// rstrip("/")s it at construction, while config.js strips it at read. Same
// effective URL, so this only pins that the NAME has not diverged.
test('both languages read the bridge URL from the same env var name', () => {
  const cfgJs = readFileSync(path.join(REPO_ROOT, 'server/src/config.js'), 'utf8')
  const cfgPy = readFileSync(path.join(REPO_ROOT, 'farm/config.py'), 'utf8')
  assert.match(cfgJs, /process\.env\.WA_BRIDGE_URL/)
  assert.match(cfgPy, /os\.environ\.get\("WA_BRIDGE_URL"/)
})
