// Route/wiring layer, separated from the listen/boot entry (server.js) so
// tests can build the app and drive it with fastify.inject().

import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import crypto from 'node:crypto'
import * as store from './store.js'
import * as github from './github.js'
import * as deploy from './deploy.js'
import * as orchestrator from './orchestrator.js'
import {
  WEBHOOK_SECRET,
  FARM_SHARED_SECRET,
  FARM_URL,
  UI_URL,
  SESSION_COOKIE_NAME,
  SESSION_TTL_DAYS,
  TEST_HOOKS_ENABLED,
} from './config.js'
import { marked } from 'marked'
import { db } from './db.js'
import { getActiveProjectId, getRepoUrl, setSetting, getToken } from './settings.js'
import * as auth from './auth.js'
import { googleAuth } from './googleAuth.js'
import { isAllowedEmail } from './loginAllowlist.js'
import { approvalSecretConfigured, approvalSecretOk, isAllowedApprover, normalizeJid } from './waApprovers.js'
import * as waPollVotes from './waPollVotes.js'
import { STEPS } from '../../domain/js/lifecycle.js'
import { intakeFields } from '../../domain/js/fields.js'
import { PERSONAS } from './personas.js'
import * as definitions from './definitions.js'
import * as runLogView from './runLogView.js'
import { readFileSync } from 'node:fs'

// These routes render plain HTML server-side (no React, no bundler) and
// interpolate values we don't fully control — item ids and step labels come
// from GitHub issues, and `output`/`artifact` are raw agent/tmux text. They
// sit behind the same session-cookie gate as every other /api/* route (HZ-21)
// but every interpolated value below still goes through esc() (or is already
// trusted HTML, like marked.parse() output) — otherwise a crafted issue title
// or agent output could run as script in a logged-in visitor's browser.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Shared look for the small standalone pages below (artifact viewer, step
// output, live log tail), authored as plain CSS in pages.css and served at
// /api/agent-pages.css rather than duplicated inline per page.
const PAGES_CSS = readFileSync(new URL('./pages.css', import.meta.url), 'utf8')

// Each page below links the stylesheet with a relative href, not an absolute
// one: this app is reverse-proxied under a subpath in production (see
// infra/host/nginx-site.conf) that it has no env var for, so an absolute
// "/api/agent-pages.css" would 404 there. A relative href resolves correctly
// in both places because the browser computes it against its own address
// bar. `routePath` is the exact string passed to `fastify.get` for that page,
// so the "../" count always matches the route's real nesting depth.
function cssHrefFor(routePath) {
  const depth = routePath.replace(/^\/api\//, '').split('/').length - 1
  return `${'../'.repeat(depth)}agent-pages.css`
}

// Full-page artifact viewer shell shared by the latest-attempt route and the
// specific-attempt route below (HZ-46) — same markup either way, only the
// route (for the stylesheet's relative "../" depth) and which `run` row is
// rendered differ. Also renders the "attempt X of Y" nav line, replacing the
// old bare "· attempt N" text so the page prints one attempt indicator, not
// two. The feedback label per attempt is a best-effort heuristic: `target` on
// the `feedback` row only records an agent name, not a step_index, so two
// steps run by the same agent (e.g. both "Eng") could in rare cases show a
// revision as driven by feedback meant for the other step. No schema change
// to fix this — see the HZ-46 options doc's Option B trade-offs.
function renderArtifactPage(id, stepIndex, run, routePath) {
  const step = STEPS[stepIndex]
  const title = `${esc(id)} · ${esc(step?.label || `step ${stepIndex}`)}`
  const attempts = store.listStepAttempts(id, stepIndex)
  const current = attempts.find((a) => a.attempt === run.attempt)
  // The feedback shown next to "attempt X of Y" is what drove *this* attempt
  // — the thing a reviewer opening this page wants to check was addressed.
  // Other attempts get a link (to compare against) labelled with whatever
  // drove *that* revision instead, so the "X of Y" line never repeats its
  // own attempt number a second time.
  const currentFeedback = current?.feedback ? ` — “${esc(current.feedback)}”` : ''
  const otherLinks = attempts
    .filter((a) => a.attempt !== run.attempt)
    .map((a) => {
      const url = `/api/items/${encodeURIComponent(id)}/artifacts/${stepIndex}/${a.attempt}`
      const feedbackLabel = a.feedback ? ` — “${esc(a.feedback)}”` : ''
      return `<a href="${url}">attempt ${a.attempt}</a>${feedbackLabel}`
    })
  const nav = `<div class="attempts">attempt ${run.attempt} of ${attempts.length}${currentFeedback}${otherLinks.length ? ' · other versions: ' + otherLinks.join(' · ') : ''}</div>`
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${cssHrefFor(routePath)}"></head><body><div class="page">
<div class="meta"><a href="${UI_URL}/${esc(id.toLowerCase())}">← ${esc(id)} in Horizon</a> · ${title} · ${esc(run.ended_at)} UTC</div>
${nav}
<article>${marked.parse(run.artifact)}</article>
</div></body></html>`
}

// ---- SSE ----

const sseClients = new Set()

function snapshot() {
  return {
    repoUrl: getRepoUrl(),
    projects: store.listProjects(),
    activeProjectId: getActiveProjectId(),
    farm: orchestrator.getFarmState(),
    sync: github.getSyncState(),
    items: store.listItems(), // scoped to the active project
  }
}

// Human gates are human-only: every account gets its own auto-generated gate
// PIN, a cryptographic blocker kept separate from login so an AI agent (which
// can read this database) still can't self-approve its own gate. By the time
// this runs the auth hook below has already confirmed request.user.
function humanAuthorized(request, reply) {
  if (auth.verifyGatePin(request.user.id, request.headers['x-human-key'] || '')) return true
  reply.code(401).send({ error: 'human_gate_key_required' })
  return false
}

// Routes reachable without a login session: the auth routes themselves, the
// GitHub webhook (HMAC-verified, GitHub can't send a cookie), the farm
// callbacks (farmAuthorized, the farm's shared secret), the WhatsApp-approval
// leg (HZ-140 — its own WA_APPROVAL_SECRET plus a server-held approver
// allowlist; FARM_SHARED_SECRET gets a 401 there now), the shared stylesheet,
// and the deploy liveness probe (HZ-43 — nginx proxies /horizon/api/
// wholesale, so deploy.sh has no session to send; see /api/health below for
// what stays out of its payload).
const SESSION_EXEMPT = [
  /^\/api\/auth\//,
  /^\/api\/webhooks\/github$/,
  /^\/api\/farm\//,
  /^\/api\/agent-pages\.css$/,
  /^\/api\/items\/[^/]+\/gates\/\d+\/approve-via-whatsapp$/,
  // HZ-142's poll-vote leg. Same credential and the same allowlist as the
  // line above — the bridge is a daemon and has no session either.
  /^\/api\/wa\/poll-vote$/,
  /^\/api\/health$/,
]

function sessionExempt(url) {
  const path = url.split('?')[0]
  return SESSION_EXEMPT.some((re) => re.test(path))
}

function cookieIsSecure() {
  return UI_URL.startsWith('https')
}

function startSession(reply, userId) {
  const token = auth.createSession(userId)
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieIsSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  })
}

export function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`
  sseClients.forEach((res) => res.write(data))
}

store.onChange(broadcast)

// Heartbeat comment keeps proxies from idle-closing the stream and lets the
// browser notice dead connections promptly.
setInterval(() => {
  sseClients.forEach((res) => res.write(':ping\n\n'))
}, 25_000).unref()

// POST /api/items's body properties, DERIVED from domain/fields.json (HZ-134).
// Before this, every length here was a literal that had drifted from the PM
// agent's own cap for the same field — the API accepted a 2,000-char guardrails
// a PM revision could only write 400 of. The JSON-Schema *shape* stays here on
// purpose: a Fastify body schema is a transport artifact, and guardrail 5 keeps
// transport out of domain/. Only the numbers cross the boundary.
//
// Exported so server/test/api-field-limits-derived.test.mjs can diff this
// fragment against domain/fields.json read independently (success metric 2).
// That test's other leg is behavioural — it posts at maxLength and maxLength+1
// through the real route — because a structural diff alone could not tell you
// whether the route is actually using this object.
//
// `required` and the `priority` enum stay literals below: neither is a length,
// so neither belongs in a file about field limits. Recorded in domain/README.md
// so the split is findable rather than rediscovered.
export const ITEM_BODY_PROPERTIES = Object.fromEntries(
  intakeFields().map((f) => [
    f.name,
    { type: 'string', ...(f.minLength === undefined ? {} : { minLength: f.minLength }), maxLength: f.maxLength },
  ]),
)

export function buildApp({ logger = true } = {}) {
  const fastify = Fastify({ logger })

  fastify.register(fastifyCookie)

  // Keep the raw request body so webhook signatures can be verified.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body
    try {
      done(null, body === '' ? {} : JSON.parse(body))
    } catch (err) {
      err.statusCode = 400
      done(err)
    }
  })

  // Every /api/* route requires a logged-in session except SESSION_EXEMPT
  // (auth routes, the GitHub webhook, farm callbacks, the WhatsApp approval
  // leg, and the shared stylesheet) — this is the app-level login gate that
  // replaces nginx's HTTP Basic Auth (HZ-21).
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || sessionExempt(request.url)) return
    const user = auth.getSessionUser(request.cookies[SESSION_COOKIE_NAME])
    if (!user) {
      reply.code(401).send({ error: 'login_required' })
      return
    }
    request.user = user
  })

  fastify.get('/api/stream', (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    reply.raw.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    sseClients.add(reply.raw)
    request.raw.on('close', () => sseClients.delete(reply.raw))
  })

  // ---- REST ----

  const idParam = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
  }

  function send(reply, result) {
    if (result.error === 'not_found') return reply.code(404).send(result)
    if (result.error) return reply.code(409).send(result)
    return reply.send(result)
  }

  fastify.get('/api/items', () => snapshot())

  // Public liveness probe for deploy.sh (HZ-43): every /api/* route sits
  // behind the session gate above except this one, because nginx proxies
  // /horizon/api/ wholesale and deploy.sh has no session cookie to send. The
  // payload stays coarse on purpose — an ok flag and a row count, nothing
  // from a work item's contents — since anything exempted here is reachable
  // by anyone on the internet with no login. The count comes from a raw DB
  // query rather than store.listItems() so it can't silently start failing
  // again the way the old /api/items probe did (HZ-21 gated /api/items;
  // store.listItems() is also scoped to the active project, a second way an
  // unrelated app change could break this probe).
  fastify.get('/api/health', (request, reply) => {
    let itemCount
    try {
      itemCount = db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n
    } catch {
      return reply.code(503).send({ ok: false })
    }
    return { ok: true, itemCount }
  })

  // Stylesheet shared by the standalone pages below. Cacheable by the
  // browser across all three instead of re-sent inline with every page.
  fastify.get('/api/agent-pages.css', (request, reply) => {
    reply.type('text/css').send(PAGES_CSS)
  })

  // Full-page, formatted view of a step's artifact ("View full artifact"
  // opens this in a new tab — the inline viewport is too cramped for plans).
  const ARTIFACT_ROUTE = '/api/items/:id/artifacts/:stepIndex'
  fastify.get(
    ARTIFACT_ROUTE,
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'stepIndex'],
          properties: { id: { type: 'string' }, stepIndex: { type: 'integer', minimum: 0 } },
        },
      },
    },
    (request, reply) => {
      const { id, stepIndex } = request.params
      const run = db
        .prepare(
          "SELECT artifact, attempt, ended_at FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' AND artifact IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .get(id, stepIndex)
      if (!run) return reply.code(404).send({ error: 'no artifact for that step' })
      return reply.type('text/html').send(renderArtifactPage(id, stepIndex, run, ARTIFACT_ROUTE))
    },
  )

  // A specific earlier attempt's artifact (HZ-46) — previous versions are
  // retained in step_run indefinitely but were unreachable by any URL before
  // this route. Scoped by item_id AND step_index AND attempt together so an
  // attempt number from the URL can never read another item's or another
  // step's row, and filtered the same way as the route above (`status='done'
  // AND artifact IS NOT NULL`) so a failed/cancelled/superseded attempt (its
  // output starts with "FAILED:" and it never gets an artifact — see HZ-44)
  // can't be addressed as though it were a real prior version.
  const ARTIFACT_ATTEMPT_ROUTE = '/api/items/:id/artifacts/:stepIndex/:attempt'
  fastify.get(
    ARTIFACT_ATTEMPT_ROUTE,
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'stepIndex', 'attempt'],
          properties: {
            id: { type: 'string' },
            stepIndex: { type: 'integer', minimum: 0 },
            attempt: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    (request, reply) => {
      const { id, stepIndex, attempt } = request.params
      const run = db
        .prepare(
          "SELECT artifact, attempt, ended_at FROM step_run WHERE item_id = ? AND step_index = ? AND attempt = ? AND status = 'done' AND artifact IS NOT NULL",
        )
        .get(id, stepIndex, attempt)
      if (!run) return reply.code(404).send({ error: 'no artifact for that attempt' })
      return reply.type('text/html').send(renderArtifactPage(id, stepIndex, run, ARTIFACT_ATTEMPT_ROUTE))
    },
  )

  // Live per-run log tail (HZ-5): proxies farmd's pipe-pane mirror so the UI
  // can show an active run's tmux output. PM-session steps (0/1/2/9) share
  // one log file and 404 here — the Live activity panel skips them.
  fastify.get(
    '/api/runs/:runId/log',
    {
      schema: {
        params: { type: 'object', required: ['runId'], properties: { runId: { type: 'integer' } } },
        querystring: { type: 'object', properties: { offset: { type: 'integer', minimum: 0, default: 0 } } },
      },
    },
    async (request, reply) => {
      if (!FARM_URL) return reply.code(503).send({ error: 'farm unavailable' })
      try {
        const { status, data } = await orchestrator.fetchRunLog(request.params.runId, request.query.offset)
        return reply.code(status).send(data)
      } catch {
        return reply.code(503).send({ error: 'farm unavailable' })
      }
    },
  )

  // Full-page view of a completed step's raw agent output ("See agent
  // output" opens this in a new tab instead of showing the text inline,
  // HZ-14). Same session-cookie gate as the artifact page above, so opening
  // it in a new tab never asks for a second login.
  const OUTPUT_ROUTE = '/api/items/:id/steps/:stepIndex/output'
  fastify.get(
    OUTPUT_ROUTE,
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'stepIndex'],
          properties: { id: { type: 'string' }, stepIndex: { type: 'integer', minimum: 0 } },
        },
      },
    },
    (request, reply) => {
      const { id, stepIndex } = request.params
      const run = db
        .prepare(
          "SELECT output, attempt, ended_at FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' AND output IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .get(id, stepIndex)
      if (!run) return reply.code(404).send({ error: 'no output for that step' })
      const step = STEPS[stepIndex]
      const title = `${esc(id)} · ${esc(step?.label || `step ${stepIndex}`)}`
      const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${cssHrefFor(OUTPUT_ROUTE)}"></head><body><div class="page">
<div class="meta"><a href="${UI_URL}/${esc(id.toLowerCase())}">← ${esc(id)} in Horizon</a> · ${title} · attempt ${run.attempt} · ${esc(run.ended_at)} UTC</div>
<pre>${esc(run.output)}</pre>
</div></body></html>`
      return reply.type('text/html').send(html)
    },
  )

  // Standalone page that live-tails an active run ("See agent output" for the
  // step currently running, HZ-14). Client-side script polls the JSON log
  // route above every 2s and stops after a 3-minute wall clock so an
  // abandoned tab can't poll forever; a Reconnect button resumes it. This
  // route itself does no polling of its own — no new server-side memory/CPU
  // per viewer, same as the artifact/output pages.
  const LOG_VIEW_ROUTE = '/api/runs/:runId/log/view'
  fastify.get(
    LOG_VIEW_ROUTE,
    {
      schema: {
        params: { type: 'object', required: ['runId'], properties: { runId: { type: 'integer' } } },
      },
    },
    (request, reply) => {
      const { runId } = request.params
      const run = db.prepare('SELECT item_id, step_index FROM step_run WHERE id = ?').get(runId)
      const step = run ? STEPS[run.step_index] : null
      const heading = run ? `${esc(run.item_id)} · ${esc(step?.label || `step ${run.step_index}`)}` : `Run ${runId}`
      const backLink = run
        ? `<a href="${UI_URL}/${esc(run.item_id.toLowerCase())}">← ${esc(run.item_id)} in Horizon</a> · `
        : ''
      const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} · agent output</title>
<link rel="stylesheet" href="${cssHrefFor(LOG_VIEW_ROUTE)}"></head><body><div class="page">
<div class="meta">${backLink}${heading} · agent output</div>
<pre id="log">Waiting for output…</pre>
<p id="status" aria-live="polite"></p>
<button id="reconnect" type="button" hidden>Reconnect</button>
</div>
<script>${runLogView.clientScript()}</script>
</body></html>`
      return reply.type('text/html').send(html)
    },
  )

  // Create a work item. With GitHub connected this creates the issue there
  // (GitHub stays the source of truth) and ingests it; in demo mode it creates
  // a local item. Title, outcome and success metric are the bot farm's minimum
  // intake requirements — enforced here, not just in the UI.
  fastify.post(
    '/api/items',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title', 'outcome', 'metric'],
          properties: {
            ...ITEM_BODY_PROPERTIES,
            priority: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'], default: 'Medium' },
          },
        },
      },
    },
    async (request, reply) => {
      const { title, outcome, metric, guardrails = '', priority = 'Medium', repo } = request.body
      // New work goes into the active project only.
      const activeId = getActiveProjectId()
      const connected = store.listRepos().filter((r) => activeId == null || r.project_id === activeId)
      if (connected.length > 0) {
        const target = repo
          ? connected.find((r) => r.repo === repo) || null
          : connected.length === 1
            ? connected[0]
            : null
        if (!target) {
          return reply.code(400).send({ error: 'Pick which of the active project’s repositories this work item belongs to' })
        }
        let ghIssue
        try {
          ghIssue = await github.createIssue(target.repo, { title, outcome, metric, guardrails, priority })
        } catch (err) {
          return reply.code(502).send({ error: err.message })
        }
        store.upsertFromGithub(ghIssue, target.repo)
        return { ok: true, id: `${target.prefix}-${ghIssue.number}`, issue: ghIssue.number, url: ghIssue.html_url }
      }
      if (store.listRepos().length > 0) {
        return reply.code(400).send({ error: 'The active project has no connected repositories — add one in Admin' })
      }
      const id = store.createLocalItem({ title, outcome, metric, guardrails, priority })
      return { ok: true, id }
    },
  )

  // Shared by the session/gate-PIN browser route and the WhatsApp-concierge
  // route below — same merge/close/approve sequence, only the actor label and
  // the auth check at the call site differ. Returns either a store.js-shaped
  // result ({ok:true} / {error:'not_found'|'not_at_gate'|'stale_step'}) or
  // {error, status:502} for a merge/close failure, which the caller maps to
  // a 502 instead of send()'s default 404/409.
  async function performGateApproval(id, stepIndex, notes, actor = 'You') {
    // Accepting the code means merging its PR — the gate does not advance if
    // the merge fails, and the reason is logged to the item's activity.
    const item = store.getItem(id)
    if (
      item &&
      item.cursor === stepIndex &&
      STEPS[stepIndex]?.label === 'Accept the code' &&
      item.pr != null &&
      item.repo
    ) {
      try {
        await github.mergePr(item)
        store.addEvent(id, {
          who: 'Horizon',
          text: `merged PR #${item.pr} (squash) and deleted the work branch`,
          color: '#0E6E74',
          initials: 'HZ',
        })
      } catch (err) {
        store.addEvent(id, {
          who: 'Horizon',
          text: `could not merge PR #${item.pr}: ${err.message} — the gate stays open`,
          color: '#9C333E',
          initials: 'HZ',
        })
        store.notifyChange()
        return { error: `merge failed: ${err.message}`, status: 502 }
      }
    }
    // The final gate closes the GitHub issue (with a summary comment) so the
    // issue state and the board state can't drift. No close, no gate.
    if (
      item &&
      item.cursor === stepIndex &&
      STEPS[stepIndex]?.label === 'Review the work & close' &&
      item.issue != null &&
      item.repo
    ) {
      try {
        await github.closeIssueWithSummary(item)
        store.addEvent(id, {
          who: 'Horizon',
          text: `closed issue #${item.issue} on GitHub with a summary`,
          color: '#0E6E74',
          initials: 'HZ',
        })
      } catch (err) {
        store.addEvent(id, {
          who: 'Horizon',
          text: `could not close issue #${item.issue}: ${err.message} — the gate stays open`,
          color: '#9C333E',
          initials: 'HZ',
        })
        store.notifyChange()
        return { error: `issue close failed: ${err.message}`, status: 502 }
      }
    }
    const result = store.approveGate(id, stepIndex, notes, actor)
    // Approval notes are decisions — mirror them onto the issue thread.
    if (!result.error && notes && item?.repo && item.issue != null) {
      github
        .postIssueComment(
          item,
          `### ✅ Gate approved — ${STEPS[stepIndex].label}\n\n> ${notes}\n\n_${actor} · [open in Horizon](${UI_URL}/${id.toLowerCase()}) · posted by Horizon_`,
        )
        .catch(() => {})
    }
    return result
  }

  fastify.post(
    '/api/items/:id/gates/:stepIndex/approve',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'stepIndex'],
          properties: { id: { type: 'string' }, stepIndex: { type: 'integer', minimum: 0 } },
        },
        body: {
          type: 'object',
          properties: { notes: { type: 'string', maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { id, stepIndex } = request.params
      const notes = (request.body?.notes || '').trim()
      const result = await performGateApproval(id, stepIndex, notes, request.user.name)
      if (result.status === 502) return reply.code(502).send({ error: result.error })
      return send(reply, result)
    },
  )

  // WhatsApp-concierge leg of gate approval (HZ-15, re-secured by HZ-140).
  //
  // This route used to be guarded by farmAuthorized() — the same
  // FARM_SHARED_SECRET that farm/tmux_mgr.py forwarded into every agent
  // session — and it trusted the `sender` string the caller supplied, with
  // the approver allowlist living farm-side where a forged call simply never
  // ran it. Any agent with Bash could therefore approve its own gate.
  //
  // Now it proves its own origin, in three checks that all run BEFORE
  // performGateApproval, so a rejected call leaves the cursor, the
  // gate_decision rows and the event log untouched:
  //
  //   503  no WA_APPROVAL_SECRET on this host — fail closed, never open
  //   401  wrong/missing credential (FARM_SHARED_SECRET included: it is not
  //        accepted here any more, which is the whole point)
  //   403  senderJid is not on the server-held WA_APPROVER_JIDS allowlist
  //
  // farmAuthorized() is unchanged and still guards /api/farm/*, which farmd
  // — not an agent — calls. `sender` survives only as a display label: the
  // sender's name is folded into the actor string so every WhatsApp approval
  // stays attributable in the event log, gate_decision row and the mirrored
  // GitHub comment, the same way GitHub- and browser-driven approvals are.
  // Identity, though, comes from senderJid and nothing else.
  fastify.post(
    '/api/items/:id/gates/:stepIndex/approve-via-whatsapp',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'stepIndex'],
          properties: { id: { type: 'string' }, stepIndex: { type: 'integer', minimum: 0 } },
        },
        body: {
          type: 'object',
          required: ['senderJid'],
          properties: {
            senderJid: { type: 'string', minLength: 1, maxLength: 120 },
            sender: { type: 'string', maxLength: 120 },
            notes: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!approvalSecretConfigured()) return reply.code(503).send({ error: 'wa_approval_not_configured' })
      if (!approvalSecretOk(request.headers['x-wa-approval-secret'])) {
        return reply.code(401).send({ error: 'bad_approval_secret' })
      }
      const senderJid = request.body.senderJid
      // Checked before the item is even looked up, so a rejected sender gets
      // no oracle for which item ids exist.
      if (!isAllowedApprover(senderJid)) return reply.code(403).send({ error: 'sender_not_allowed' })
      const { id, stepIndex } = request.params
      const notes = (request.body?.notes || '').trim()
      // Same shape the farm sends today; falls back to the last 4 digits of
      // the (now proven) jid when no display name rides along.
      const label = (request.body.sender || '').trim() || `...${normalizeJid(senderJid).slice(-4)}`
      const actor = `${label} via WhatsApp`
      const result = await performGateApproval(id, stepIndex, notes, actor)
      if (result.status === 502) return reply.code(502).send({ error: result.error })
      return send(reply, result)
    },
  )

  // WhatsApp gate-approval POLL vote (HZ-142).
  //
  // The route above is the concierge's free-text leg: a human types at a
  // model, the model decides an approval happened, and the farm calls it.
  // That produced false "processing that approval now" replies and wiped
  // pending offers. This is the replacement — a tap on a native two-option
  // poll, resolved deterministically. Both stay live through the rollout;
  // whichever decides the gate first moves the cursor, and the cursor check
  // in waPollVotes.js is what stops the other one deciding it twice.
  //
  // GUARDRAIL 1: no model is reachable from here. waPollVotes.js imports no
  // orchestrator and no personas (pinned by wa-poll-no-model.test.mjs), and
  // the two actions below are handed to it rather than imported by it, so
  // this file importing the orchestrator does not widen its reach.
  //
  // The 503/401/403 ladder is the same three helpers, in the same order, as
  // approve-via-whatsapp: all three run before any lookup or any write, so a
  // rejected caller gets no oracle and an unauthorised flood writes no rows.
  //
  // EVERY 4xx IS FINAL. The bridge retries 5xx and network failures only — a
  // 403 retried forever would hammer this route over one unauthorised tap.
  fastify.post(
    '/api/wa/poll-vote',
    {
      schema: {
        body: {
          type: 'object',
          required: ['voteId', 'pollMessageId', 'voterJid', 'selectedOption'],
          properties: {
            voteId: { type: 'string', minLength: 1, maxLength: 120 },
            pollMessageId: { type: 'string', minLength: 1, maxLength: 120 },
            voterJid: { type: 'string', minLength: 1, maxLength: 120 },
            selectedOption: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!approvalSecretConfigured()) return reply.code(503).send({ error: 'wa_approval_not_configured' })
      if (!approvalSecretOk(request.headers['x-wa-approval-secret'])) {
        return reply.code(401).send({ error: 'bad_approval_secret' })
      }
      const { voteId, pollMessageId, voterJid, selectedOption } = request.body
      if (!isAllowedApprover(voterJid)) return reply.code(403).send({ error: 'voter_not_allowed' })

      const result = await waPollVotes.applyVote(
        { voteId, pollMsgId: pollMessageId, voterJid, selectedOption },
        {
          approve: (id, stepIndex, notes, actor) => performGateApproval(id, stepIndex, notes, actor),
          // targetStepIndex stays null: store.requestChanges derives the
          // default rework target itself, Accept-gate exception included. A
          // second derivation here could only ever drift from that one.
          sendBack: (id, feedback, actor) =>
            store.requestChanges(id, STEPS[store.getItem(id)?.cursor]?.label || null, feedback, actor, null),
        },
      )
      if (result.status === 200) {
        return reply.code(200).send({
          ok: true,
          outcome: result.outcome,
          ...(result.itemId ? { itemId: result.itemId, stepIndex: result.stepIndex, choice: result.choice } : {}),
        })
      }
      // Logged, not just answered. unknown_poll in particular is the tappable
      // orphan a crash mid-send leaves behind: silent, it looks to the human
      // exactly like the bug this item removes.
      request.log?.warn?.(`wa poll vote ${voteId} ignored: ${result.outcome}${result.error ? ` (${result.error})` : ''}`)
      return reply.code(result.status).send({ error: result.error || result.outcome })
    },
  )

  fastify.post(
    '/api/items/:id/reject',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            feedback: { type: 'string' },
            targetStepIndex: { type: 'integer' },
          },
        },
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      return send(
        reply,
        store.requestChanges(
          request.params.id,
          request.body?.target,
          request.body?.feedback,
          request.user.name,
          request.body?.targetStepIndex ?? null,
        ),
      )
    },
  )

  // HZ-92: mechanical merge-conflict resolution — same gate PIN requirement
  // as /reject above (this is the fast path that replaces sending the item
  // straight back to the implement step), the Accept gate itself is
  // untouched either way.
  fastify.post(
    '/api/items/:id/resolve-conflicts',
    { schema: { params: idParam } },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const result = await orchestrator.resolveConflicts(request.params.id, request.user.name)
      return send(reply, result)
    },
  )

  // Standalone feedback — the UI leg of "agents respond to feedback". If the
  // item is mid-agent-step the attempt is superseded and re-run with the
  // feedback ({rerun:true}); parked at a gate it queues for the next dispatch
  // ({queued:true}).
  fastify.post(
    '/api/items/:id/feedback',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 2000 },
            target: { type: 'string', maxLength: 40 },
          },
        },
      },
    },
    (request, reply) => {
      const { id } = request.params
      const { message, target = '' } = request.body
      const item = store.getItem(id)
      const result = store.addFeedback(id, { message, target, source: 'ui' })
      // Mirror onto the issue thread (footer marks it ours so ingestion skips it).
      if (!result.error && item?.repo && item.issue != null) {
        github
          .postIssueComment(item, `### 💬 Feedback\n\n> ${message}\n\n_Human · [open in Horizon](${UI_URL}/${id.toLowerCase()}) · posted by Horizon_`)
          .catch(() => {})
      }
      return send(reply, result)
    },
  )

  fastify.post(
    '/api/items/:id/pause',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['paused'],
          properties: { paused: { type: 'boolean' } },
        },
      },
    },
    (request, reply) => send(reply, store.setPaused(request.params.id, request.body.paused)),
  )

  // Dependencies (HZ-78): id is blocked until dependsOnId closes. Cycles and
  // self-dependencies are rejected here (store.addDependency, fail-closed —
  // see lifecycle.js/store.js), so a malformed graph never reaches the
  // orchestrator's dispatch gate at all.
  fastify.post(
    '/api/items/:id/dependencies',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['dependsOnId'],
          properties: { dependsOnId: { type: 'string', minLength: 1 } },
        },
      },
    },
    (request, reply) => send(reply, store.addDependency(request.params.id, request.body.dependsOnId, request.user.name)),
  )

  // Same shape as /projects/:id/repos/disconnect — a removal is a POST to a
  // named sub-route rather than DELETE, matching this API's existing style.
  fastify.post(
    '/api/items/:id/dependencies/remove',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['dependsOnId'],
          properties: { dependsOnId: { type: 'string', minLength: 1 } },
        },
      },
    },
    (request, reply) => send(reply, store.removeDependency(request.params.id, request.body.dependsOnId, request.user.name)),
  )

  // Confirm/override the specialist persona (proposed by the PM at intake).
  // Unknown ids 400 at the schema layer; the next dispatch reads the item.
  fastify.post(
    '/api/items/:id/persona',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['persona'],
          properties: { persona: { type: 'string', enum: Object.keys(PERSONAS) } },
        },
      },
    },
    (request, reply) => send(reply, store.setPersona(request.params.id, request.body.persona)),
  )

  // Reprioritize (UI or the WhatsApp concierge). Bad enum values 400 at the
  // schema layer; the GitHub label mirror is best-effort and never blocks.
  fastify.post(
    '/api/items/:id/priority',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['priority'],
          properties: { priority: { type: 'string', enum: store.PRIORITIES } },
        },
      },
    },
    (request, reply) => {
      const { id } = request.params
      const item = store.getItem(id)
      const result = store.setPriority(id, request.body.priority)
      if (!result.error && !result.unchanged && item?.repo && item.issue != null) {
        github.setPriorityLabel(item, request.body.priority).catch(() => {})
      }
      return send(reply, result)
    },
  )

  fastify.post(
    '/api/items/:id/phases/:phase/restart',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'phase'],
          properties: { id: { type: 'string' }, phase: { type: 'integer', minimum: 0, maximum: 4 } },
        },
        body: {
          type: 'object',
          properties: { reason: { type: 'string' } },
        },
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      return send(
        reply,
        store.restartPhase(request.params.id, request.params.phase, request.body?.reason, request.user.name),
      )
    },
  )

  // Soft delete (HZ-59): stop a work item that should not proceed. Gated by
  // the same human gate PIN as gate approval — dropping work is at least as
  // consequential as approving it, and the PIN is what keeps an agent with
  // DB/API access from abandoning its own inconvenient work. The DB write
  // (store.abandonItem) happens BEFORE the GitHub close below: closing the
  // issue fires Horizon's own issues.closed webhook back at itself, and
  // upsertFromGithub must see abandoned_at already set or it could race to
  // reclassify this item as completed instead of abandoned. The GitHub close
  // is best-effort and never fails the request — a human can close the issue
  // by hand; the item is already correctly abandoned in Horizon either way.
  fastify.post(
    '/api/items/:id/abandon',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { id } = request.params
      const item = store.getItem(id)
      const result = store.abandonItem(id, request.body.reason, request.user.name)
      if (result.error) return send(reply, result)
      if (item?.repo && item.issue != null) {
        try {
          await github.closeIssueAsAbandoned(item, request.body.reason.trim())
          store.addEvent(id, {
            who: 'Horizon',
            text: `closed issue #${item.issue} on GitHub as not planned`,
            color: '#0E6E74',
            initials: 'HZ',
          })
        } catch (err) {
          store.addEvent(id, {
            who: 'Horizon',
            text: `could not close issue #${item.issue}: ${err.message} — close it manually`,
            color: '#9C333E',
            initials: 'HZ',
          })
        }
        store.notifyChange()
      }
      return send(reply, result)
    },
  )

  // ---- auth (HZ-21: hardcoded credential OR Google SSO, per-account gate PIN) ----

  fastify.post(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 200 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    (request, reply) => {
      const user = auth.verifyPassword(request.body.email.trim(), request.body.password)
      if (!user) return reply.code(401).send({ error: 'invalid_credentials' })
      startSession(reply, user.id)
      return { ok: true, user }
    },
  )

  // Server-driven redirect to Google's consent screen — no Google JS SDK in
  // the UI bundle. `oauth_state` is a short-lived CSRF nonce checked at the
  // callback.
  fastify.get('/api/auth/google/start', (request, reply) => {
    // Browser-facing (reached via a plain <a href>, not fetch()) — every
    // error on this route family redirects to the login page instead of
    // rendering raw JSON in the tab (HZ-37).
    if (!googleAuth.configured()) return reply.redirect(`${UI_URL}/?error=google_sso_not_configured`)
    const state = crypto.randomBytes(16).toString('hex')
    reply.setCookie('oauth_state', state, {
      httpOnly: true,
      secure: cookieIsSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 300,
    })
    reply.redirect(googleAuth.buildAuthUrl(state))
  })

  fastify.get(
    '/api/auth/google/callback',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { code: { type: 'string' }, state: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { code, state } = request.query
      const expected = request.cookies.oauth_state
      if (!code || !state || !expected || state !== expected) {
        return reply.redirect(`${UI_URL}/?error=bad_state`)
      }
      let profile
      try {
        profile = await googleAuth.exchangeCodeForProfile(code)
      } catch (err) {
        request.log.warn(`google oauth exchange failed: ${err.message}`)
        return reply.redirect(`${UI_URL}/?error=google_auth_failed`)
      }
      // Allowlist gate (HZ-36): checked against the VERIFIED email claim
      // only, and before any user lookup or write — a rejected login never
      // creates or touches a row. One error code for every rejection reason
      // (unverified claim or a verified-but-not-allowlisted address) so the
      // response can't be used to enumerate which emails are allowed.
      if (!profile.emailVerified || !isAllowedEmail(profile.email)) {
        request.log.warn('google login rejected: not allowlisted')
        return reply.redirect(`${UI_URL}/?error=google_login_not_allowed`)
      }
      let user
      try {
        user = auth.findOrCreateGoogleUser(profile)
      } catch (err) {
        if (err instanceof auth.GoogleLinkBlockedError) {
          // Unverified email, or already linked to a different Google
          // identity — never surfaces as a raw JSON crash (HZ-37).
          request.log.warn(`google link blocked: ${err.message}`)
          return reply.redirect(`${UI_URL}/?error=google_link_blocked`)
        }
        // Reachable only if two callbacks for a brand-new email race into the
        // INSERT; the linking path above handles the ordinary collision. Still
        // worth a redirect over a raw 500 — the user can simply retry.
        request.log.warn(`google account linking failed: ${err.message}`)
        return reply.redirect(`${UI_URL}/?error=account_link_failed`)
      }
      // Consumed only now that the login has actually succeeded. Clearing it
      // any earlier burns the nonce on a failed callback, and the natural
      // retry — go back, pick another account from Google's chooser, which
      // replays the same state — then arrives with no cookie and reports
      // `bad_state`, masking the real first error. Still single-use, and it
      // expires on its own after 5 minutes (maxAge in /google/start).
      reply.clearCookie('oauth_state', { path: '/' })
      startSession(reply, user.id)
      return reply.redirect(UI_URL)
    },
  )

  fastify.post('/api/auth/logout', (request, reply) => {
    auth.deleteSession(request.cookies[SESSION_COOKIE_NAME])
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    return { ok: true }
  })

  fastify.get('/api/auth/me', (request, reply) => {
    const user = auth.getSessionUser(request.cookies[SESSION_COOKIE_NAME])
    if (!user) return reply.code(401).send({ error: 'login_required' })
    return { user }
  })

  // Requires only a login session (not the PIN itself) — regenerating your
  // own PIN can't be gated behind the PIN it's replacing.
  fastify.post('/api/auth/gate-pin/regenerate', (request, reply) => {
    const user = auth.getSessionUser(request.cookies[SESSION_COOKIE_NAME])
    if (!user) return reply.code(401).send({ error: 'login_required' })
    return { ok: true, pin: auth.regenerateGatePin(user.id) }
  })

  // ---- agent definitions (HZ-9: hierarchical, git-versioned, UI-editable) ----

  fastify.get('/api/definitions', () => definitions.listDefinitions())

  // Static segment registered alongside /:kind/:name — Fastify prefers it.
  fastify.get(
    '/api/definitions/effective',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            role: { type: 'string', maxLength: 100 },
            persona: { type: 'string', maxLength: 100 },
            project: { type: 'string', maxLength: 200 },
            repo: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    (request) => ({ prompt: definitions.effectivePrompt(request.query) }),
  )

  const definitionParams = {
    type: 'object',
    required: ['kind', 'name'],
    properties: { kind: { type: 'string' }, name: { type: 'string', maxLength: 200 } },
  }

  fastify.get('/api/definitions/:kind/:name', { schema: { params: definitionParams } }, (request, reply) => {
    const def = definitions.readDefinition(request.params.kind, request.params.name)
    if (!def) return reply.code(404).send({ error: 'unknown_definition' })
    return def
  })

  // Edits are human-gated (same PIN as approvals) and become git commits with
  // the actor in the message — git history is the audit trail. The actor is
  // always the authenticated session's own name, never client-supplied.
  // Global kinds (role/persona) affect every project; the UI labels them as such.
  fastify.put(
    '/api/definitions/:kind/:name',
    {
      schema: {
        params: definitionParams,
        body: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 20000 },
          },
        },
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { kind, name } = request.params
      const actor = request.user.name
      try {
        return definitions.writeDefinition(kind, name, request.body.content, actor)
      } catch (err) {
        if (err.code === 'unknown_definition') return reply.code(404).send({ error: err.code })
        if (err.code === 'rules_too_large') return reply.code(400).send({ error: err.code, limit: err.limit })
        if (err.code === 'credential_pattern') return reply.code(400).send({ error: err.code, matches: err.matches })
        if (err.code === 'empty_content') return reply.code(400).send({ error: err.code })
        if (err.code === 'git_dirty') return reply.code(409).send({ error: err.code })
        if (err.code === 'push_failed') {
          return reply.code(502).send({ error: err.code, commit: err.commit, detail: err.detail })
        }
        throw err
      }
    },
  )

  // ---- Deploy targets (HZ-41, read-only) ----
  // The registry itself (infra/host/deploy-targets.json) is a versioned file
  // with no write path from this app — this endpoint only surfaces each
  // target's on-disk deploy state for the Admin page.

  fastify.get('/api/admin/deploy-targets', () => ({ targets: deploy.listTargetStatuses() }))

  // ---- GitHub sync configuration (from the UI) ----

  fastify.get('/api/sync/status', () => github.getSyncState())

  // Save the shared GitHub token (validated before persisting).
  fastify.post(
    '/api/sync/token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 10 } },
        },
      },
    },
    async (request, reply) => {
      const token = request.body.token.trim()
      const check = await github.validateToken(token)
      if (!check.ok) return reply.code(400).send({ error: check.error })
      setSetting('github_token', token)
      // The token's identity backs the comment-ingestion echo guard: comments
      // authored by this login are Horizon's own mirrors, never feedback.
      setSetting('github_login', check.login)
      await github.pollOnce(request.log)
      broadcast()
      return { ok: true, login: check.login }
    },
  )

  fastify.post(
    '/api/projects',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 2, maxLength: 80 } },
        },
      },
    },
    (request, reply) => {
      const result = store.createProject(request.body.name.trim())
      if (result.error === 'exists') return reply.code(409).send({ error: 'A project with that name already exists' })
      orchestrator.ensureFarm(request.log) // first project => farm comes up for it
      broadcast()
      return result
    },
  )

  // Connect a repo to a project; issues from it start syncing immediately.
  fastify.post(
    '/api/projects/:id/repos',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        body: {
          type: 'object',
          required: ['repo'],
          properties: { repo: { type: 'string', minLength: 1, maxLength: 300 } },
        },
      },
    },
    async (request, reply) => {
      const repo = github.parseRepo(request.body.repo)
      if (!repo) {
        return reply
          .code(400)
          .send({ error: 'Repository must be owner/name or a github.com URL, e.g. https://github.com/FinTekkers/shoreward' })
      }
      const check = await github.validateRepo(repo, getToken())
      if (!check.ok) return reply.code(400).send({ error: check.error })
      const canonical = check.fullName || repo
      const result = store.addRepoToProject(request.params.id, canonical)
      if (result.error === 'project_not_found') return reply.code(404).send({ error: 'Project not found' })
      if (result.error === 'repo_already_connected') {
        return reply.code(409).send({ error: 'That repository is already connected' })
      }
      await github.pollRepo(repo, request.log).catch(() => {})
      broadcast()
      return result
    },
  )

  // Activate a project: the bot farm restarts with that project's context.
  fastify.post(
    '/api/projects/:id/activate',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
      },
    },
    (request, reply) => {
      const project = store.listProjects().find((p) => p.id === request.params.id)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      if (project.id === getActiveProjectId()) return { ok: true, alreadyActive: true }
      orchestrator.switchProject(project.id, request.log)
      broadcast()
      return { ok: true, restarting: true }
    },
  )

  fastify.post(
    '/api/projects/:id/repos/disconnect',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        body: {
          type: 'object',
          required: ['repo'],
          properties: { repo: { type: 'string', minLength: 1, maxLength: 300 } },
        },
      },
    },
    (request, reply) => {
      const result = store.removeRepoFromProject(request.params.id, request.body.repo)
      if (result.error) return reply.code(404).send({ error: 'That repository is not connected to this project' })
      broadcast()
      return result
    },
  )

  // ---- farm callbacks (farm/ Python daemon reporting step results) ----

  function farmAuthorized(request, reply) {
    if ((request.headers['x-farm-secret'] || '') !== FARM_SHARED_SECRET) {
      reply.code(401).send({ error: 'bad farm secret' })
      return false
    }
    return true
  }

  // The snapshot the WhatsApp concierge renders into its replies. It is a
  // daemon with no browser session, so it cannot use /api/items — HZ-21 gated
  // that route and the concierge has 401'd on every message since. Served
  // here rather than by exempting /api/items, because nginx proxies
  // /horizon/api/ wholesale: anything in SESSION_EXEMPT is reachable from the
  // internet with no login, and /api/items carries every work item's full
  // contents. This sits behind the farm's own shared-secret boundary instead.
  fastify.get('/api/farm/snapshot', (request, reply) => {
    if (!farmAuthorized(request, reply)) return
    return snapshot()
  })

  // Pushed by farmd the instant it claims a queued task (ephemeral dispatch
  // or the PM queue) — flips the run's watchdog from the queue-wait timer to
  // the real execution budget, timed from now instead of from dispatch
  // (HZ-57: queue time was burning the whole deadline before a step ever
  // ran). `active: false` in the reply tells farmd NOT to launch the task —
  // the run was already cancelled server-side.
  fastify.post(
    '/api/farm/steps/:runId/started',
    {
      schema: {
        params: { type: 'object', required: ['runId'], properties: { runId: { type: 'integer' } } },
      },
    },
    (request, reply) => {
      if (!farmAuthorized(request, reply)) return
      return orchestrator.markFarmRunStarted(request.params.runId)
    },
  )

  fastify.post(
    '/api/farm/steps/:runId/complete',
    {
      schema: {
        params: { type: 'object', required: ['runId'], properties: { runId: { type: 'integer' } } },
        body: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string', maxLength: 2000 },
            patch: { type: 'object' },
            artifacts: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!farmAuthorized(request, reply)) return
      return orchestrator.completeFarmRun(request.params.runId, request.body)
    },
  )

  fastify.post(
    '/api/farm/steps/:runId/fail',
    {
      schema: {
        params: { type: 'object', required: ['runId'], properties: { runId: { type: 'integer' } } },
        body: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string', maxLength: 2000 }, reason: { type: 'string', maxLength: 100 } },
        },
      },
    },
    (request, reply) => {
      if (!farmAuthorized(request, reply)) return
      return orchestrator.failFarmRun(request.params.runId, request.body.error, request.body.reason || null)
    },
  )

  // ---- GitHub webhook (event-based sync) ----
  // Point a repo webhook (or a smee.io/ngrok tunnel locally) at this endpoint
  // with content type application/json and the shared secret.

  fastify.post('/api/webhooks/github', (request, reply) => {
    if (!WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'webhooks_not_configured', hint: 'set GITHUB_WEBHOOK_SECRET' })
    }
    if (!github.verifySignature(WEBHOOK_SECRET, request.rawBody ?? '', request.headers['x-hub-signature-256'])) {
      return reply.code(401).send({ error: 'bad_signature' })
    }
    const event = request.headers['x-github-event']
    const repoFullName = request.body?.repository?.full_name
    if (event === 'issues' && request.body?.issue && repoFullName) {
      store.upsertFromGithub(request.body.issue, repoFullName) // no-op for unconnected repos
    }
    // Issue comments are the GitHub leg of feedback: "users interact mostly by
    // GH comments". Edits are deliberately not re-ingested (the comment id is
    // already recorded).
    if (event === 'issue_comment' && request.body?.action === 'created' && request.body?.comment && repoFullName) {
      github.ingestComment(repoFullName, request.body.issue?.number, request.body.comment, request.log)
    }
    // PRs decided directly on GitHub flow back into the lifecycle: merged →
    // "Accept the code" approved; closed unmerged → sent back for rework.
    if (event === 'pull_request' && request.body?.action === 'closed' && request.body?.pull_request && repoFullName) {
      const pr = request.body.pull_request
      github.handlePrStateChange(repoFullName, pr.number, { merged: !!pr.merged, state: pr.state }, request.log)
    }
    // A published release on a registered repo self-deploys: pull the tag to
    // the host and restart, no SSH/push access needed. Which repos are
    // deployable — and to where — is decided entirely by the versioned
    // registry (infra/host/deploy-targets.json), not by anything in this
    // payload beyond repoFullName itself.
    if (event === 'release' && repoFullName) {
      if (deploy.isDeployableRelease(repoFullName, request.body)) {
        deploy.runDeploy(repoFullName, request.body.release.tag_name, request.log)
      } else {
        request.log.warn(`self-deploy: ignored release event from ${repoFullName}`)
      }
    }
    return reply.code(204).send()
  })

  // e2e only (HZ-54): the e2e suite has no live farm daemon (FARM_URL is
  // unset for it), so nothing ever calls pollRunStates() with real data. This
  // route — registered only when HORIZON_TEST_HOOKS=1, which is never set in
  // production — lets a spec seed the orchestrator's run-state cache
  // directly, so the board's queued/running rendering gets real end-to-end
  // coverage. Still sits behind the normal session-cookie gate (it's not in
  // SESSION_EXEMPT), same as every other /api/* route.
  if (TEST_HOOKS_ENABLED) {
    fastify.post('/api/test/run-state', async (request, reply) => {
      const { run_id, state, reason } = request.body || {}
      orchestrator.setRunStateForTest(run_id, state, reason ?? null)
      return { ok: true }
    })
  }

  return fastify
}
