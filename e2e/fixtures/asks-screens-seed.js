// HZ-730: the rows behind the `asks-*` screens in .horizon/screenshots.json —
// an item with one blocking ask (reviewed: accept) and one soft ask (reviewed:
// amend, with the reviewer's draft), and a second item with one soft ask, so
// the Follow-ups list shows two groups. e2e/screenshots/seed.mjs seeds them
// before the server boots: both items sit at a gate, so nothing moves them,
// and each ask already has its review, so the HZ-729 sweep leaves it alone.

import { insertItem, insertProject, insertStepRun, insertAsk, insertAskReview } from './seed.js'
import { requiredStepIndex } from '../../domain/js/lifecycle.js'
import { LATER } from './layout-screens-seed.js'

export const ASKS_ID = 'AS-730'
export const ASKS_OTHER_ID = 'AS-731'
const REVIEW_GATE = requiredStepIndex('Review before execution')
const ARCH = requiredStepIndex('Architecture review')
const QA_PLAN = requiredStepIndex('QA reviews the test plan')
const REPO = 'FinTekkers/ledger-models'

const draft = (title, outcome) => ({
  title,
  repo: REPO,
  outcome,
  metric: '1. A test shows it.\n2. The docs say so.\n3. Nothing else changes.',
  guardrails: '1. No new secrets.',
})

function seedItem(db, { id, title, project_id, asks }) {
  insertItem(db, {
    id,
    title,
    cursor: REVIEW_GATE,
    repo: REPO,
    project_id,
    desc: 'Trades settle through the new ledger API.',
    metric: '1. Every trade settles through the new API.\n2. The old path is unused.',
    guardrails: '1. No change to settlement amounts.',
  })
  db.prepare('UPDATE work_item SET created_at = ?, updated_at = ? WHERE id = ?').run(LATER, LATER, id)
  for (const [i, ask] of asks.entries()) {
    const stepIndex = ask.stepIndex ?? ARCH
    const stepRunId = insertStepRun(db, {
      itemId: id,
      stepIndex,
      attempt: 1,
      agent: ask.agent ?? 'Architect',
      output: 'reviewed',
      startedAt: '2099-01-01 00:00:00',
      endedAt: '2099-01-01 00:05:00',
    })
    const askId = insertAsk(db, { itemId: id, stepRunId, stepIndex, kind: ask.kind, why: ask.why, ...ask.draft })
    db.prepare('UPDATE ask SET created_at = ?, updated_at = ? WHERE id = ?').run(`2099-01-01 00:0${i}:00`, LATER, askId)
    insertAskReview(db, { askId, ...ask.review })
  }
}

export function seedAsksScreens(db) {
  if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ASKS_ID)) return
  db.transaction(() => {
    const project_id = insertProject(db, { name: 'Asks project' })
    seedItem(db, {
      id: ASKS_ID,
      title: 'Settle trades through the new ledger API',
      project_id,
      asks: [
        {
          kind: 'blocking',
          why: "The publish script commits under the owner's identity.",
          draft: draft('Publish script must use the bot identity', 'The publish script commits as the release bot.'),
          review: { verdict: 'accept', reasons: ['Fits the project rules; no open item covers it.'] },
        },
        {
          kind: 'soft',
          why: 'The settlement docs still describe the old API.',
          draft: draft('Update the settlement docs', 'The docs describe the new API.'),
          review: {
            verdict: 'amend',
            reasons: ['Narrowed to the one page that is out of date.'],
            amendedDraft: draft('Update the settlement page of the API docs', 'The settlement page describes the new ledger API.'),
          },
        },
      ],
    })
    seedItem(db, {
      id: ASKS_OTHER_ID,
      title: 'Price feed retries on a timeout',
      project_id,
      asks: [
        {
          kind: 'soft',
          stepIndex: QA_PLAN,
          agent: 'QA',
          why: 'The retry count is not shown anywhere.',
          draft: draft('Show the retry count on the price feed page', 'The owner sees how often the feed retried.'),
          review: { verdict: 'escalate', reasons: ['Overlaps a dashboard item; the owner should choose.'] },
        },
      ],
    })
  })()
}
