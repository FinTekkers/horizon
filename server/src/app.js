// Route/wiring layer, separated from the listen/boot entry (server.js) so
// tests can build the app and drive it with fastify.inject().

import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import crypto from 'node:crypto'
import * as store from './store.js'
import * as github from './github.js'
import * as deploy from './deploy.js'
import * as orchestrator from './orchestrator.js'
import { WEBHOOK_SECRET, FARM_SHARED_SECRET, FARM_URL, UI_URL, SESSION_COOKIE_NAME, SESSION_TTL_DAYS } from './config.js'
import { marked } from 'marked'
import { db } from './db.js'
import { getActiveProjectId, getRepoUrl, setSetting, getToken } from './settings.js'
import * as auth from './auth.js'
import { googleAuth } from './googleAuth.js'
import { isAllowedEmail } from './loginAllowlist.js'
import { STEPS } from './lifecycle.js'
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
// callbacks and the WhatsApp-approval leg (both authorized by the farm's
// shared secret instead), the shared stylesheet, and the deploy liveness
// probe (HZ-43 — nginx proxies /horizon/api/ wholesale, so deploy.sh has no
// session to send; see /api/health below for what stays out of its payload).
const SESSION_EXEMPT = [
  /^\/api\/auth\//,
  /^\/api\/webhooks\/github$/,
  /^\/api\/farm\//,
  /^\/api\/agent-pages\.css$/,
  /^\/api\/items\/[^/]+\/gates\/\d+\/approve-via-whatsapp$/,
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
      const step = STEPS[stepIndex]
      const title = `${esc(id)} · ${esc(step?.label || `step ${stepIndex}`)}`
      const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${cssHrefFor(ARTIFACT_ROUTE)}"></head><body><div class="page">
<div class="meta"><a href="${UI_URL}/${esc(id.toLowerCase())}">← ${esc(id)} in Horizon</a> · ${title} · attempt ${run.attempt} · ${esc(run.ended_at)} UTC</div>
<article>${marked.parse(run.artifact)}</article>
</div></body></html>`
      return reply.type('text/html').send(html)
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
            title: { type: 'string', minLength: 3, maxLength: 200 },
            outcome: { type: 'string', minLength: 10, maxLength: 4000 },
            metric: { type: 'string', minLength: 5, maxLength: 2000 },
            guardrails: { type: 'string', maxLength: 2000 },
            priority: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'], default: 'Medium' },
            repo: { type: 'string', maxLength: 300 },
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

  // WhatsApp-concierge leg of gate approval (HZ-15): authorized by the farm's
  // shared secret + the concierge's own WhatsApp sender allowlist, not the
  // browser-only human gate key — a deliberate, narrower trust boundary. The
  // sender's name is always folded into the actor label so every WhatsApp
  // approval is attributable in the event log, gate_decision row, and the
  // mirrored GitHub comment, the same way GitHub- and browser-driven
  // approvals already are.
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
          required: ['sender'],
          properties: {
            sender: { type: 'string', minLength: 1, maxLength: 120 },
            notes: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!farmAuthorized(request, reply)) return
      const { id, stepIndex } = request.params
      const notes = (request.body?.notes || '').trim()
      const actor = `${request.body.sender.trim()} via WhatsApp`
      const result = await performGateApproval(id, stepIndex, notes, actor)
      if (result.status === 502) return reply.code(502).send({ error: result.error })
      return send(reply, result)
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
          properties: { error: { type: 'string', maxLength: 2000 } },
        },
      },
    },
    (request, reply) => {
      if (!farmAuthorized(request, reply)) return
      return orchestrator.failFarmRun(request.params.runId, request.body.error)
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

  return fastify
}
