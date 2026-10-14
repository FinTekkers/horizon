// HZ-236: the deterministic overlap check behind step 9's `## Overlap`
// section. Pure functions only — no DB, no network — so every decision can be
// tested without a model, and the model writing the digest can explain a
// decision but never change it (overlapService.js owns the reads and writes).
//
// A footprint is what an item will touch: { files, symbols, changed }.
// Symbols are functions normalised to `name()` and endpoints to `METHOD /path`.
// HZ-466: `changed` maps each symbol the item defines or changes (not merely
// calls) to the files it is tied to. Its keys are always a subset of `symbols`.
// Only names ever leave this module — never raw plan prose or patch lines, so
// a secret sitting in a diff cannot reach a prompt, a digest or a log.

import { IMPLEMENT_STEP_INDEX, DEPLOY_STEP_INDEX, requiredStepIndex } from '../../domain/js/lifecycle.js'

const BACKTICK_RE = /`([^`\n]+)`/g
const FILE_EXT_RE = /\.(?:c?js|mjs|jsx|tsx?|py|md|json|sql|sh|css|html|ya?ml|toml)$/i
const CALL_RE = /^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*\(/
const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?#]*)/i
const IDENT_RE = /^[A-Za-z_$][\w$]*$/
const HUNK_HEADER_RE = /^@@ [^@]* @@ ?(.*)$/
const HUNK_CALL_RE = /([A-Za-z_$][\w$]*)\s*\(/
const JS_DEF_RE = /^[+-]\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/
const PY_DEF_RE = /^[+-]\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
// Words that sit in front of `(` without naming a function.
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'async', 'def', 'class'])
// HZ-466: names so common that two items sharing one is a coincidence unless
// both tie it to the same file.
export const GENERIC_NAMES = new Set([
  'render', 'validate', 'run', 'init', 'main', 'handle', 'get', 'set', 'update',
  'load', 'save', 'parse', 'build', 'start', 'stop', 'create', 'process',
])
// A plan line names a change to its symbols only when it says so, and a line
// that also calls or uses them is read as a call. Matched on the line's prose
// with backticked spans removed, so `removeThing()` is not the verb "remove".
const CHANGE_VERB_RE = /\b(?:add|added|adds|change|changed|changes|modify|modified|modifies|rename|renamed|renames|replace|replaced|replaces|remove|removed|removes|delete|deleted|deletes|define|defined|defines|new|extend|extended|extends|rewrite|rewrites|rewritten)\b/i
const CALL_VERB_RE = /\b(?:call|called|calls|calling|use|used|uses|using|reuse|reused|reuses|invoke|invoked|invokes|via)\b/i
const HEADING_RE = /^\s*(?:#{1,6}\s|\*\*)/

export const DECISIONS = ['none', 'depends-on', 'shared-contract']

function normalizeFile(token) {
  const path = token.trim().replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '')
  if (!path.includes('/') || /[\s*]/.test(path) || !FILE_EXT_RE.test(path)) return null
  return path
}

function functionSymbol(name) {
  return name && IDENT_RE.test(name) && !NOT_A_FUNCTION.has(name) ? `${name}()` : null
}

function endpointSymbol(token) {
  const m = ENDPOINT_RE.exec(token.trim())
  if (!m) return null
  const path = m[2].length > 1 ? m[2].replace(/\/+$/, '') : m[2]
  return `${m[1].toUpperCase()} ${path}`
}

// `changed` is a Map of symbol → Set of files; only symbols also in `symbols`
// are kept, so the shared-symbol text and the link decision never disagree.
function footprint(files, symbols, changed = new Map()) {
  const out = {}
  for (const name of [...changed.keys()].filter((n) => symbols.has(n)).sort()) out[name] = [...changed.get(name)].sort()
  return { files: [...files].sort(), symbols: [...symbols].sort(), changed: out }
}

function markChanged(changed, symbol, files) {
  if (!changed.has(symbol)) changed.set(symbol, new Set())
  for (const f of files) changed.get(symbol).add(f)
}

function tokenSymbol(token) {
  return endpointSymbol(token) || functionSymbol(CALL_RE.exec(token)?.[1])
}

// A step-6 plan's footprint, read from its backticked tokens only: a path with
// a `/` and a known extension is a file, `name(` is a function, and
// `GET /api/...` is an endpoint. A bare `name` without parens is not a symbol —
// a plan that writes it that way still overlaps on the file it names.
// HZ-466: read line by line. A symbol counts as changed only on a line with a
// change verb and no call verb; its files are the files on that line, else
// those of the nearest heading (`## …` or a `**…` lead line) above it.
export function extractPlanFootprint(md) {
  const files = new Set()
  const symbols = new Set()
  const changed = new Map()
  let headingFiles = []
  for (const line of String(md || '').split('\n')) {
    const lineFiles = []
    const lineSymbols = []
    for (const [, raw] of line.matchAll(BACKTICK_RE)) {
      const token = raw.trim()
      const file = endpointSymbol(token) ? null : normalizeFile(token)
      if (file) {
        files.add(file)
        lineFiles.push(file)
        continue
      }
      const symbol = tokenSymbol(token)
      if (symbol) {
        symbols.add(symbol)
        lineSymbols.push(symbol)
      }
    }
    if (HEADING_RE.test(line) && lineFiles.length > 0) headingFiles = lineFiles
    const prose = line.replace(BACKTICK_RE, ' ')
    if (lineSymbols.length > 0 && CHANGE_VERB_RE.test(prose) && !CALL_VERB_RE.test(prose)) {
      for (const symbol of lineSymbols) markChanged(changed, symbol, lineFiles.length > 0 ? lineFiles : headingFiles)
    }
  }
  return footprint(files, symbols, changed)
}

// A PR diff's footprint: the changed file names, plus the functions named by
// each hunk header (`@@ -10,6 +10,8 @@ export function snapshot() {` gives
// `snapshot()`) and by function definitions on added or removed lines. The
// patch text itself is read here and dropped here. Every one of those names
// is a change (HZ-466), tied to the patch's file; a call site names nothing.
export function footprintFromPrFiles(prFiles) {
  const files = new Set()
  const symbols = new Set()
  const changed = new Map()
  for (const f of Array.isArray(prFiles) ? prFiles : []) {
    const file = typeof f?.filename === 'string' ? f.filename.trim() : ''
    if (file) files.add(file)
    const patch = typeof f?.patch === 'string' ? f.patch : ''
    for (const line of patch.split('\n')) {
      const header = HUNK_HEADER_RE.exec(line)
      const name = header ? HUNK_CALL_RE.exec(header[1])?.[1] : (JS_DEF_RE.exec(line) || PY_DEF_RE.exec(line))?.[1]
      const fn = functionSymbol(name)
      if (!fn) continue
      symbols.add(fn)
      markChanged(changed, fn, file ? [file] : [])
    }
  }
  return footprint(files, symbols, changed)
}

export function isEmptyFootprint(fp) {
  return !fp || (fp.files.length === 0 && fp.symbols.length === 0)
}

// HZ-466: which peers a depends-on link may point at — only items whose code
// is actually being built. A paused item (rule-blocked ones are paused too),
// one still planning, or one waiting at Review before execution gets a
// shared-contract note instead. `rule_block_json` is read only while paused,
// so a stale value never holds back a resumed item. Accept the code counts as
// in review: the code exists.
const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const REVIEW_GATE_STEP = requiredStepIndex('Review before execution')

export function peerStateOf(row) {
  if (row?.paused) return { linkable: false, state: row.rule_block_json ? 'rule-blocked' : 'paused' }
  const cursor = row?.cursor
  if (cursor >= PLAN_STEP && cursor < REVIEW_GATE_STEP) return { linkable: false, state: 'still planning' }
  if (cursor === REVIEW_GATE_STEP) return { linkable: false, state: 'waiting at the Review before execution gate' }
  if (cursor === IMPLEMENT_STEP_INDEX) return { linkable: true, state: 'implementing' }
  if (cursor > IMPLEMENT_STEP_INDEX && cursor < DEPLOY_STEP_INDEX) return { linkable: true, state: 'in review' }
  if (cursor === DEPLOY_STEP_INDEX) return { linkable: true, state: 'merged, not deployed' }
  return { linkable: false, state: 'not in flight' }
}

const has = (changed, symbol) => Boolean(changed) && Object.hasOwn(changed, symbol)
const bareName = (symbol) => symbol.replace(/\(\)$/, '')

// The decision is owned here. A shared function or endpoint serialises the
// two items; a shared file alone gets a contract — so a symbol the extractor
// missed still lands on shared-contract, never on a silent `none`.
// HZ-466: a shared symbol links only if `other` defines or changes it, a
// generic name only if both sides change it in a common file, and only when
// the peer is linkable. Anything else shared is a shared-contract, with `why`.
export function decideOverlap(self, other, peer = { linkable: true, state: '' }) {
  const otherFiles = new Set(other.files)
  const otherSymbols = new Set(other.symbols)
  const sharedFiles = self.files.filter((f) => otherFiles.has(f))
  const sharedSymbols = self.symbols.filter((s) => otherSymbols.has(s))
  const who = peer.id || 'the other item'
  const reasons = []
  const linkSymbols = sharedSymbols.filter((s) => {
    if (!has(other.changed, s)) {
      reasons.push(`${who} only calls \`${s}\``)
      return false
    }
    if (!GENERIC_NAMES.has(bareName(s))) return true
    const mine = new Set(has(self.changed, s) ? self.changed[s] : [])
    if (other.changed[s].some((f) => mine.has(f))) return true
    reasons.push(`\`${s}\` is a generic name and the two items do not change it in the same file`)
    return false
  })
  if (linkSymbols.length > 0 && peer.linkable) return { decision: 'depends-on', sharedFiles, sharedSymbols }
  if (sharedSymbols.length === 0 && sharedFiles.length === 0) return { decision: 'none', sharedFiles, sharedSymbols }
  const why = peer.linkable ? reasons.join('; ') : `${who} is ${peer.state}; links go only to items implementing, in review or merged but not deployed`
  const result = { decision: 'shared-contract', sharedFiles, sharedSymbols }
  if (why) result.why = why
  return result
}

// One exact contract condition. The ids and names are sorted so both items
// produce the same text whichever of them reaches step 9 first — that is what
// keeps a re-run, from either side, from queueing a second copy.
export function contractText(selfId, otherId, sharedFiles, sharedSymbols = []) {
  const [a, b] = [selfId, otherId].sort()
  const onFiles = sharedFiles.length > 0
  const targets = [...(onFiles ? sharedFiles : sharedSymbols)].sort().map((t) => `\`${t}\``).join(', ')
  return `${a} and ${b} both change ${targets}. Whichever merges second rebases onto the other first and keeps the other item's tests ${onFiles ? 'in those files' : 'for that code'} passing.`
}

const list = (values) => (values.length > 0 ? values.map((v) => `\`${v}\``).join(', ') : 'none')

// The authoritative `## Overlap` section, built from applied results.
export function renderOverlapSection(check) {
  const lines = ['## Overlap']
  if (!check.repo) {
    lines.push('This item has no repository, so there is nothing to compare.')
    return lines.join('\n')
  }
  if (check.results.length === 0) {
    lines.push(`No other in-flight items in \`${check.repo}\`.`)
    return lines.join('\n')
  }
  lines.push(
    `Checked against ${check.results.length} other in-flight item(s) in \`${check.repo}\` (steps 6–14). The server computed these decisions; the digest cannot change them.`,
  )
  for (const r of check.results) {
    if (r.decision === 'not-checked') {
      lines.push(`- **${r.id}** — **not checked** — ${r.reason}`)
      continue
    }
    if (r.decision === 'none') {
      lines.push(`- **${r.id}** — decision: **none** — no shared files or functions/endpoints`)
      continue
    }
    lines.push(`- **${r.id}** — decision: **${r.decision}**`)
    lines.push(`  - Shared files: ${list(r.sharedFiles)}`)
    lines.push(`  - Shared functions/endpoints: ${list(r.sharedSymbols)}`)
    if (r.contract) lines.push(`  - Contract: ${r.contract}`)
    if (r.why) lines.push(`  - Why: ${r.why}`)
    if (r.effect) lines.push(`  - Effect: ${r.effect}`)
  }
  return lines.join('\n')
}

const MAX_INPUT_PEERS = 20
const MAX_INPUT_NAMES = 40

const capped = (values) =>
  values.length > MAX_INPUT_NAMES ? `${list(values.slice(0, MAX_INPUT_NAMES))} (+${values.length - MAX_INPUT_NAMES} more)` : list(values)

// The step-9 prompt's view of the check: every peer's planned or changed files
// and the decision the server will apply. Context only — the completion-time
// recompute is what gets applied and written into the digest.
export function renderOverlapInput(check) {
  const lines = [`This item: **${check.self.id}** — ${check.self.sourceLabel}`]
  if (check.self.files) {
    lines.push(`- Files: ${capped(check.self.files)}`, `- Functions/endpoints: ${capped(check.self.symbols)}`)
  }
  lines.push('', `Other in-flight items in \`${check.repo || 'no repository'}\` (steps 6–14):`)
  if (check.results.length === 0) lines.push('- none')
  for (const r of check.results.slice(0, MAX_INPUT_PEERS)) {
    lines.push(`- **${r.id}** — ${r.sourceLabel || 'nothing to read'}`)
    if (r.files) lines.push(`  - Files: ${capped(r.files)}`, `  - Functions/endpoints: ${capped(r.symbols)}`)
    lines.push(
      r.decision === 'not-checked' ? `  - Computed decision: **not checked** — ${r.reason}` : `  - Computed decision: **${r.decision}**`,
    )
  }
  if (check.results.length > MAX_INPUT_PEERS) {
    lines.push(`- … ${check.results.length - MAX_INPUT_PEERS} more item(s) not shown here; the server's section covers all of them`)
  }
  lines.push(
    '',
    'The server appends the authoritative `## Overlap` section to your digest after you finish. Do not write one. You may refer to these decisions in `## Actions`, but never call a listed overlap `none`.',
  )
  return lines.join('\n')
}

// Drops any `## Overlap` section the model wrote (up to the next `## ` heading
// or the end) and appends the server's section last, after `## Actions`.
// Every other byte of the digest is kept as written.
export function replaceOverlapSection(md, section) {
  const kept = []
  let skipping = false
  for (const line of String(md || '').split('\n')) {
    if (/^## /.test(line)) skipping = /^## Overlap\b/.test(line)
    if (!skipping) kept.push(line)
  }
  const base = kept.join('\n')
  const sep = base === '' || base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n'
  return `${base}${sep}${section}\n`
}
