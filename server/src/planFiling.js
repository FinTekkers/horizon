// HZ-449: a Plan's File items step — files every draft the owner approved at
// Approve & file as a real item, through spawn.js's spawnItems, the same
// idempotent engine a Task files its change with.
//
// The drafts are read only through planDraft.currentDraft (HZ-448's store).
// The `#n` -> real key map is the Plan's item_spawn rows under PLAN_FILE_KEY:
// one row per draft, seq = n, so UNIQUE(parent_id, request_key, seq) keeps a
// draft from ever being filed twice. A run that fails part-way leaves the
// filed rows filed; the step's retry files only the rest, with the same map.
//
// Each draft is filed after every draft it depends on or names in its text
// (filingOrder), so its `#n`s are rewritten to real keys before its row's
// payload is frozen. Its dependencies become edges through
// store.addDependency. Filing creates items only in repos within the Plan's
// scope and never edits, closes or relabels an existing item. The Plan does
// not wait on what it files: no edge from the Plan, so no linkSpawned.

import { db } from './db.js'
import * as store from './store.js'
import { UI_URL } from './config.js'
import { PLAN_FILE_KEY, currentDraft } from './planDraft.js'
import { spawnItems, validateSpawnSpec } from './spawn.js'
import { filedText, filingOrder, rewriteLocalRefs } from '../../domain/js/planDraft.js'
import { isAbandoned, isClosed } from '../../domain/js/lifecycle.js'

export { PLAN_FILE_KEY }

const selectRows = db.prepare('SELECT seq, status, child_id, error FROM item_spawn WHERE parent_id = ? AND request_key = ? ORDER BY seq')

// { '#n': { key, status, error? } } for every draft a filing has reached:
// status 'filed' with its real key, or 'filing' / 'failed' with key null.
export function filedMap(itemId) {
  const map = {}
  for (const row of selectRows.all(itemId, PLAN_FILE_KEY)) {
    map[`#${row.seq}`] = { key: row.child_id ?? null, status: row.status, ...(row.error ? { error: row.error } : {}) }
  }
  return map
}

const itemLink = (key) => `[${key}](${UI_URL}/${key.toLowerCase()})`

// Files the Plan's current drafts. `stopped()` is asked before each draft: a
// Plan paused or abandoned mid-filing, or a run cancelled under it, stops
// before the next draft. Resolves { summary, output } (output links every
// filed key) or { stopped: true }; throws when a draft cannot be filed.
export async function fileDrafts(item, { stopped = () => false } = {}) {
  const draft = currentDraft(item.id)
  if (!draft) throw new Error('the Plan has no item drafts to file')
  const { doc } = draft
  const scope = new Map(store.getPlanScope(item.id).repos.map(({ repo }) => [repo.toLowerCase(), repo]))
  const outside = doc.items.find((d) => !scope.has(d.repo.toLowerCase()))
  if (outside) throw new Error(`${outside.id}'s repo ${outside.repo} is not in the Plan's scope — filing stopped`)

  // HZ-642: one Autopilot choice for every draft, from the newest Approve &
  // file approval. It goes into each row's frozen payload, so a draft filed
  // before a send-back keeps the choice it was filed with and is never
  // relabelled: a re-approval with another choice files only the rest with
  // it, which can leave one Plan's items with mixed labels.
  const autopilotOff = store.filedAutopilotOff(item.id)
  const keys = {}
  for (const [id, entry] of Object.entries(filedMap(item.id))) if (entry.status === 'filed' && entry.key) keys[id] = entry.key
  const byId = new Map(doc.items.map((d) => [d.id, d]))
  const order = filingOrder(doc)
  for (const id of order) {
    const now = store.getItem(item.id)
    if (!now || now.paused || isAbandoned(now) || isClosed(now) || stopped()) return { stopped: true }
    const d = byId.get(id)
    const text = filedText(d, doc.shared_guardrails, item.id)
    const checked = validateSpawnSpec(Object.fromEntries(Object.entries(text).map(([field, value]) => [field, rewriteLocalRefs(value, keys)])))
    if (checked.error) throw new Error(`${id} cannot be filed: ${checked.error}`)
    const spec = {
      ...checked.spec,
      seq: Number(id.slice(1)),
      repo: scope.get(d.repo.toLowerCase()),
      priority: d.priority ?? item.priority,
      ...(d.lane ? { lane: d.lane } : {}),
      ...(autopilotOff ? { autopilotOff: true } : {}),
    }
    const filed = await spawnItems(item, [spec], { requestKey: PLAN_FILE_KEY, kind: d.kind ?? 'change', waits: false })
    if (filed.error) throw new Error(`${id}: ${filed.error}`)
    const [childKey] = filed.children
    keys[id] = childKey
    for (const dep of d.depends_on) {
      const target = rewriteLocalRefs(dep, keys)
      const linked = store.addDependency(childKey, target, 'Horizon')
      if (linked.error) throw new Error(`could not make ${childKey} depend on ${target}: ${linked.message || linked.error}`)
    }
  }
  const lines = order.map((id) => `- ${id} → ${itemLink(keys[id])} ${byId.get(id).title}`)
  return {
    summary: `filed ${order.length} item${order.length === 1 ? '' : 's'}: ${order.map((id) => `${id} → ${keys[id]}`).join(', ')}`,
    output: [`Filed ${order.length} item${order.length === 1 ? '' : 's'} for Plan ${item.id}:`, '', ...lines].join('\n'),
  }
}
