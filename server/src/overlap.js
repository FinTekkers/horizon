// HZ-236: the deterministic overlap check behind step 9's `## Overlap`
// section. Pure functions only — no DB, no network — so every decision can be
// tested without a model, and the model writing the digest can explain a
// decision but never change it (overlapService.js owns the reads and writes).
//
// A footprint is what an item will touch: { files: string[], symbols: string[] }.
// Symbols are functions normalised to `name()` and endpoints to `METHOD /path`.
// Only names ever leave this module — never raw plan prose or patch lines, so
// a secret sitting in a diff cannot reach a prompt, a digest or a log.

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

function footprint(files, symbols) {
  return { files: [...files].sort(), symbols: [...symbols].sort() }
}

// A step-6 plan's footprint, read from its backticked tokens only: a path with
// a `/` and a known extension is a file, `name(` is a function, and
// `GET /api/...` is an endpoint. A bare `name` without parens is not a symbol —
// a plan that writes it that way still overlaps on the file it names.
export function extractPlanFootprint(md) {
  const files = new Set()
  const symbols = new Set()
  for (const [, raw] of String(md || '').matchAll(BACKTICK_RE)) {
    const token = raw.trim()
    const endpoint = endpointSymbol(token)
    if (endpoint) {
      symbols.add(endpoint)
      continue
    }
    const file = normalizeFile(token)
    if (file) {
      files.add(file)
      continue
    }
    const fn = functionSymbol(CALL_RE.exec(token)?.[1])
    if (fn) symbols.add(fn)
  }
  return footprint(files, symbols)
}

// A PR diff's footprint: the changed file names, plus the functions named by
// each hunk header (`@@ -10,6 +10,8 @@ export function snapshot() {` gives
// `snapshot()`) and by function definitions on added or removed lines. The
// patch text itself is read here and dropped here.
export function footprintFromPrFiles(prFiles) {
  const files = new Set()
  const symbols = new Set()
  for (const f of Array.isArray(prFiles) ? prFiles : []) {
    const file = typeof f?.filename === 'string' ? f.filename.trim() : ''
    if (file) files.add(file)
    const patch = typeof f?.patch === 'string' ? f.patch : ''
    for (const line of patch.split('\n')) {
      const header = HUNK_HEADER_RE.exec(line)
      const name = header ? HUNK_CALL_RE.exec(header[1])?.[1] : (JS_DEF_RE.exec(line) || PY_DEF_RE.exec(line))?.[1]
      const fn = functionSymbol(name)
      if (fn) symbols.add(fn)
    }
  }
  return footprint(files, symbols)
}

export function isEmptyFootprint(fp) {
  return !fp || (fp.files.length === 0 && fp.symbols.length === 0)
}

// The decision is owned here. A shared function or endpoint serialises the
// two items; a shared file alone gets a contract — so a symbol the extractor
// missed still lands on shared-contract, never on a silent `none`.
export function decideOverlap(self, other) {
  const otherFiles = new Set(other.files)
  const otherSymbols = new Set(other.symbols)
  const sharedFiles = self.files.filter((f) => otherFiles.has(f))
  const sharedSymbols = self.symbols.filter((s) => otherSymbols.has(s))
  const decision = sharedSymbols.length > 0 ? 'depends-on' : sharedFiles.length > 0 ? 'shared-contract' : 'none'
  return { decision, sharedFiles, sharedSymbols }
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
    `Checked against ${check.results.length} other in-flight item(s) in \`${check.repo}\` (steps 6–13). The server computed these decisions; the digest cannot change them.`,
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
  lines.push('', `Other in-flight items in \`${check.repo || 'no repository'}\` (steps 6–13):`)
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
