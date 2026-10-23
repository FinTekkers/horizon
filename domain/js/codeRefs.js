// HZ-546: code references and item IDs in artifacts, turned into links at
// render time. Pure — no I/O, no env — so server/src/app.js (the full artifact
// page) and ui/src/components/Markdown.jsx apply the same grammar and the same
// safety rules. Stored artifact text is never rewritten.
//
// A reference is `repo:path:line` or `repo:path:start-end`, where `repo` is
// the short name (the part after `/`) of a repo in the item's project and
// `path` is the full path from that repo's root. `path:line` with no repo is
// allowed only where the context names a default repo (a single-repo Change,
// or an Inventory row's own repo) and must still contain a `/`. A bare `:N`
// or a bare file name never parses.
//
// A link is built only from a known repo plus a recorded commit sha for it.
// Anything else — unknown repo, no sha, a path or line that fails a check —
// returns null, and the caller renders the plain code span it would have
// rendered anyway. Never a branch-tip or guessed URL.

const COMMIT_SHA = /^[0-9a-f]{40}$/
// ASCII digits only (no \d, no full-width digits), at most 7 of them.
const LINES = /^([0-9]{1,7})(?:-([0-9]{1,7}))?$/
const SHORT_NAME = /^[A-Za-z0-9._-]+$/
const FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
// Characters a path segment may not hold: `:` (a scheme or a second line
// part), `\`, `?`, `#`, `%` (already-encoded text), whitespace and controls.
const BAD_SEGMENT_CHAR = /[:\\?#%\s\u0000-\u001f\u007f]/
const ITEM_ID = /\b[A-Z]{2,6}-[0-9]+\b/g

// A full 40-hex lowercase commit sha. Also what the server keeps when it
// stores a step run's source_shas (server/src/orchestrator.js).
export function isCommitSha(value) {
  return typeof value === 'string' && COMMIT_SHA.test(value)
}

function repoName(entry) {
  const name = typeof entry === 'string' ? entry : entry?.repo
  return typeof name === 'string' && FULL_NAME.test(name) ? name : null
}

// The context both renderers pass around.
//   projectRepos — the item's project repos, 'owner/name' strings or { repo }.
//   itemRepo     — the item's own repo; the default only when !isPlan.
//   defaultRepo  — an explicit default that wins over itemRepo, even on a
//                  Plan: an Inventory row's evidence is relative to that row's
//                  repo (PlanInventoryTables.jsx). Must be a project repo.
//   sourceShas   — { 'owner/name': sha } the step run read (step_run.source_shas).
//   knownIds     — item IDs that may link. The server and the UI each build
//                  this from what they hold, so the two sets can differ.
//   itemHref     — id -> the item's Horizon page URL.
export function buildLinkContext({
  projectRepos = [],
  itemRepo = null,
  isPlan = false,
  defaultRepo = null,
  sourceShas = null,
  knownIds = null,
  itemHref = null,
} = {}) {
  const full = new Set()
  const byShort = new Map()
  const dropped = new Set()
  for (const entry of Array.isArray(projectRepos) ? projectRepos : []) {
    const name = repoName(entry)
    if (!name || full.has(name)) continue
    full.add(name)
    const short = name.split('/')[1].toLowerCase()
    // Two repos with one short name: neither gets the name, so a reference
    // to it stays plain rather than pointing at a guess.
    if (byShort.has(short)) dropped.add(short)
    else byShort.set(short, name)
  }
  for (const short of dropped) byShort.delete(short)
  const explicit = repoName(defaultRepo)
  const implicit = isPlan ? null : repoName(itemRepo)
  const fallback = explicit ?? implicit
  const shas = {}
  if (sourceShas && typeof sourceShas === 'object') {
    for (const name of full) {
      if (Object.hasOwn(sourceShas, name) && isCommitSha(sourceShas[name])) shas[name] = sourceShas[name]
    }
  }
  return {
    repos: byShort,
    defaultRepo: fallback && full.has(fallback) ? fallback : null,
    shas,
    knownIds: knownIds instanceof Set ? knownIds : new Set(Array.isArray(knownIds) ? knownIds : []),
    itemHref: typeof itemHref === 'function' ? itemHref : null,
  }
}

// encodeURIComponent, then the RFC 3986 path characters it over-encodes put
// back, so a SvelteKit `+page.server.ts` links as itself.
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%(2B|40|2C|3B|3D|24)/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function safeSegments(path) {
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || BAD_SEGMENT_CHAR.test(segment)) return null
  }
  return segments
}

// The grammar only: { repo: short name | null, path, start, end } or null.
// Which repo a reference means is codeRefUrl's job.
export function parseCodeRef(text) {
  if (typeof text !== 'string') return null
  const parts = text.trim().split(':')
  if (parts.length !== 2 && parts.length !== 3) return null
  const [repo, path, lines] = parts.length === 3 ? parts : [null, ...parts]
  if (repo !== null && !SHORT_NAME.test(repo)) return null
  // No repo: the path has to name a folder too, so a bare file name never
  // passes as a reference.
  if (repo === null && !path.includes('/')) return null
  if (!safeSegments(path)) return null
  const match = LINES.exec(lines)
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] === undefined ? start : Number(match[2])
  if (start < 1 || end < start) return null
  return { repo, path, start, end }
}

// The GitHub URL for a reference, or null. The host is fixed, `owner/name`
// comes from the context, never from the text, and each path segment is
// percent-encoded (encodeSegment).
export function codeRefUrl(ref, ctx) {
  if (!ref || !ctx) return null
  const full = ref.repo === null ? ctx.defaultRepo : ctx.repos.get(ref.repo.toLowerCase())
  if (!full) return null
  const sha = ctx.shas[full]
  if (!isCommitSha(sha)) return null
  const segments = safeSegments(ref.path)
  if (!segments) return null
  const lines = ref.end === ref.start ? `L${ref.start}` : `L${ref.start}-L${ref.end}`
  return `https://github.com/${full}/blob/${sha}/${segments.map(encodeSegment).join('/')}#${lines}`
}

// Text split into plain pieces and known item IDs: [{ text } | { id, href }].
// An ID links only when it is in ctx.knownIds; anything else stays text.
export function splitItemIds(text, ctx) {
  const value = String(text ?? '')
  if (!ctx?.itemHref || ctx.knownIds.size === 0) return [{ text: value }]
  const pieces = []
  let last = 0
  for (const match of value.matchAll(ITEM_ID)) {
    if (!ctx.knownIds.has(match[0])) continue
    if (match.index > last) pieces.push({ text: value.slice(last, match.index) })
    pieces.push({ id: match[0], href: ctx.itemHref(match[0]) })
    last = match.index + match[0].length
  }
  if (last < value.length || pieces.length === 0) pieces.push({ text: value.slice(last) })
  return pieces
}
