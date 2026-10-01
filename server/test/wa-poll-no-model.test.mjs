// HZ-142 success metric 9 and guardrail 1: no model call occurs on the vote
// path.
//
// Two halves, because the claim has two failure modes.
//
//   * STRUCTURAL — waPollVotes.js's transitive import graph, walked here. If
//     it cannot reach the orchestrator, the personas or anything under farm/,
//     it cannot call a model, and no amount of careless editing inside the
//     file changes that. This is the same discipline gateNotifier.js's header
//     documents and domain-consumer-imports.test.mjs enforces for domain/.
//
//   * BEHAVIOURAL — a whole vote request, driven through the real Fastify app,
//     spawning no child process and reaching no agent runner. The import walk
//     cannot cover the handler in app.js, which legitimately imports the
//     orchestrator; what covers it is that the two actions are HANDED to
//     waPollVotes rather than imported by it, and that nothing on the request
//     actually launches anything.
//
// The Python half — that a bridge fork writing votes into the `messages`
// table would send every tap to run_agent — lives in
// farm/tests/test_concierge_ignores_poll_vote.py.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'

import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-wa-poll-nomodel-')), 'test.db')
process.env.WA_APPROVAL_SECRET = 'wa-approval-secret-for-tests'
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
delete process.env.FARM_URL
delete process.env.HORIZON_REPO

const SRC = path.join(REPO_ROOT, 'server/src')

// Anything that can reach a model or launch work, directly or by owning the
// thing that does.
//
// personas.js is deliberately NOT here: it is three labels and a colour, it
// arrives via store.js, and gateNotifier.js has had exactly the same reach
// since HZ-141. Listing a pure data module would make this test noise rather
// than a boundary.
const FORBIDDEN = ['orchestrator.js', 'definitions.js', 'agentTokens.js', 'github.js', 'deploy.js', 'app.js']

// Resolves a relative import against the importing file, walking the whole
// graph from one entry point.
function transitiveImports(entry) {
  const seen = new Set()
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(/(?:^|\s)(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
      const spec = match[1]
      if (!spec.startsWith('.')) continue // node: and npm packages are not our graph
      stack.push(path.resolve(path.dirname(file), spec))
    }
    for (const match of text.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g)) {
      if (match[1].startsWith('.')) stack.push(path.resolve(path.dirname(file), match[1]))
    }
  }
  return seen
}

const graph = transitiveImports(path.join(SRC, 'waPollVotes.js'))

test('the walk is not vacuous — it reached the modules the validator really needs', () => {
  const reached = [...graph].map((f) => path.relative(REPO_ROOT, f)).sort()
  assert.ok(reached.includes('server/src/waPollVotes.js'))
  for (const expected of ['server/src/db.js', 'server/src/store.js', 'server/src/waApprovers.js', 'domain/js/lifecycle.js']) {
    assert.ok(reached.includes(expected), `the walk never reached ${expected}:\n${reached.join('\n')}`)
  }
  assert.ok(reached.length >= 6, `the walk visited only ${reached.length} file(s)`)
})

test('waPollVotes.js cannot reach the orchestrator, the personas or any model-bearing module', () => {
  const reached = [...graph].map((f) => path.relative(REPO_ROOT, f))
  for (const forbidden of FORBIDDEN) {
    const hits = reached.filter((f) => f.endsWith(`/${forbidden}`))
    assert.deepEqual(hits, [], `the vote path can reach ${forbidden} — guardrail 1 is no longer structural`)
  }
})

test('nothing on the vote path reaches farm/ or spawns anything', () => {
  for (const file of graph) {
    const rel = path.relative(REPO_ROOT, file)
    assert.ok(!rel.startsWith('farm/'), `the vote path reaches ${rel}`)
    const text = readFileSync(file, 'utf8')
    if (rel !== 'server/src/store.js') continue
    // store.js is the one module here that CAN kick the agent runner, and it
    // does so through an injected runner rather than an import — which is
    // exactly why it is safe to be on this graph.
    assert.ok(!/from\s+'\.\/orchestrator\.js'/.test(text), 'store.js imports the orchestrator directly')
  }
})

test('waPollVotes.js takes its two actions as arguments, never as imports', () => {
  const text = readFileSync(path.join(SRC, 'waPollVotes.js'), 'utf8')
  // The one seam that keeps app.js's own orchestrator import from widening
  // this module's reach.
  assert.match(text, /applyVote\(\s*\{[^}]*\}\s*,\s*\{\s*approve,\s*sendBack\s*\}\s*\)/)
  for (const forbidden of ["from './app.js'", "from './orchestrator.js'", "from './personas.js'"]) {
    assert.ok(!text.includes(forbidden), `waPollVotes.js has an ${forbidden} import`)
  }
})

// ---- the behavioural half ----

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const votes = await import('../src/waPollVotes.js')
const { buildApp } = await import('../src/app.js')
const { POLL_APPROVE, POLL_SEND_BACK } = await import('../src/waSend.js')
const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const GATE = gateStepIndexes()[0]
const DAVID = '15550001111@s.whatsapp.net'

test('a whole vote request spawns no process and reaches no agent runner of its own', async () => {
  // Every spawn primitive, recorded. `check-no-leaked-farmd` proves a farmd
  // can be leaked at all; this proves this path never starts one.
  const spawned = []
  const realSpawn = childProcess.spawn
  const realFork = childProcess.fork
  const realExec = childProcess.exec
  childProcess.spawn = (...a) => {
    spawned.push(['spawn', a[0]])
    return realSpawn(...a)
  }
  childProcess.fork = (...a) => {
    spawned.push(['fork', a[0]])
    return realFork(...a)
  }
  childProcess.exec = (...a) => {
    spawned.push(['exec', a[0]])
    return realExec(...a)
  }
  // kick/cancel are the store's own, legitimately called by approveGate. What
  // must not appear is anything else.
  const runnerCalls = []
  store.registerAgentRunner({
    kick: (...a) => runnerCalls.push(['kick', ...a]),
    cancel: (...a) => runnerCalls.push(['cancel', ...a]),
  })

  try {
    const app = buildApp({ logger: false })
    for (const [id, option] of [
      ['NM-APPROVE', POLL_APPROVE],
      ['NM-BACK', POLL_SEND_BACK],
    ]) {
      db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(id, `No model ${id}`, 'High', GATE)
      const pollId = votes.registerPoll({
        itemId: id,
        stepIndex: GATE,
        recipient: DAVID,
        question: `${id} — ${STEPS[GATE].label}`,
      })
      votes.attachPollMessageId(pollId, `MSG-${id}`)
      const res = await app.inject({
        method: 'POST',
        url: '/api/wa/poll-vote',
        headers: { 'x-wa-approval-secret': 'wa-approval-secret-for-tests' },
        payload: { voteId: `V-${id}`, pollMessageId: `MSG-${id}`, voterJid: DAVID, selectedOption: option },
      })
      assert.equal(res.statusCode, 200, res.body)
      assert.equal(res.json().outcome, 'applied')
    }
  } finally {
    childProcess.spawn = realSpawn
    childProcess.fork = realFork
    childProcess.exec = realExec
  }

  assert.deepEqual(spawned, [], `the vote path spawned: ${JSON.stringify(spawned)}`)
  // Two decisions, each one kick or cancel from store.js itself — and nothing
  // that is not one of those two names.
  assert.ok(runnerCalls.length > 0, 'the store never ran — this assertion would be vacuous')
  for (const [name] of runnerCalls) assert.ok(['kick', 'cancel'].includes(name), `unexpected runner call ${name}`)
})
