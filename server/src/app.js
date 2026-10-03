// Route/wiring layer, separated from the listen/boot entry (server.js) so
// tests can build the app and drive it with fastify.inject().

import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
// The package's own unwrapped plugin body, not its fastify-plugin wrapper — see
// where it is called in buildApp() for why it is invoked directly (HZ-178).
import { fastifySwagger } from '@fastify/swagger'
import crypto from 'node:crypto'
import * as store from './store.js'
import * as github from './github.js'
import * as deploy from './deploy.js'
import * as orchestrator from './orchestrator.js'
import * as premerge from './premerge.js'
import * as autoResolve from './autoResolve.js'
import * as webhooks from './webhooks.js'
import * as deployDrain from './deployDrain.js'
import * as deployDryRun from './deployDryRun.js'
import { createTarget, deleteTarget, findTargetByKey, listTargets, targetFromBody, updateTarget } from './deployTargets.js'
import {
  WEBHOOK_SECRET,
  FARM_SHARED_SECRET,
  FARM_URL,
  UI_URL,
  SESSION_COOKIE_NAME,
  SESSION_TTL_DAYS,
  TEST_HOOKS_ENABLED,
  PREMERGE_CHECK_TIMEOUT_MS,
  PREMERGE_SKIP_ENABLED,
  PREMERGE_SKIP_MAX_AGE_MS,
} from './config.js'
import { marked } from 'marked'
import { db } from './db.js'
import { getActiveProjectId, getRepoUrl, setSetting, getToken } from './settings.js'
import * as auth from './auth.js'
import { googleAuth } from './googleAuth.js'
import { isAllowedEmail } from './loginAllowlist.js'
import { approvalSecretConfigured, approvalSecretOk, isAllowedApprover, isOwner, normalizeJid } from './waApprovers.js'
import * as waPollVotes from './waPollVotes.js'
import { STEPS } from '../../domain/js/lifecycle.js'
import { intakeFields } from '../../domain/js/fields.js'
import { PRIORITIES, DEFAULT_PRIORITY } from '../../domain/js/priorities.js'
import { PERSONAS } from './personas.js'
import * as definitions from './definitions.js'
import * as rulesStore from './rulesStore.js'
import * as runLogView from './runLogView.js'
import {
  API_SECURITY,
  ERROR_OBJECT,
  HUMAN_GATE_SECURITY,
  OK_OBJECT,
  SESSION_SECURITY,
  isInternal,
  noContent,
  swaggerOptions,
  textResponse,
} from './openapi.js'
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

// `scope` picks the items: 'active' is the active project's, 'enabled' every
// enabled project's. The browser's SSE feed and GET /api/items use 'enabled'
// (HZ-208); so does the WhatsApp concierge's farm snapshot (HZ-209).
// `estimates` adds the board's top-level durationEstimates (HZ-229) — once per
// snapshot, never per item. The concierge's /api/farm/snapshot leaves it off.
// `checks` adds each repo's check commands (HZ-245) for Admin; the concierge
// leaves those off too — it has no use for them.
export function snapshot({ scope = 'active', estimates = true, checks = true } = {}) {
  return {
    repoUrl: getRepoUrl(),
    projects: store.listProjects({ checks }),
    activeProjectId: getActiveProjectId(),
    farm: orchestrator.getFarmState(),
    sync: github.getSyncState(),
    items: store.listItems({ scope }),
    ...(estimates ? { durationEstimates: store.durationEstimates() } : {}),
  }
}

// Human gates are human-only: every account gets its own auto-generated gate
// PIN, a cryptographic blocker kept separate from login so an AI agent (which
// can read this database) still can't self-approve its own gate. By the time
// this runs the auth hook below has already confirmed request.user.
//
// HZ-179: only a browser session can pass a gate. A personal API token plus
// a valid PIN is still refused — checked as "not a session" rather than "is a
// token" so any future credential type is locked out of gates by default.
function humanAuthorized(request, reply) {
  if (request.auth?.via === 'session' && auth.verifyGatePin(request.user.id, request.headers['x-human-key'] || '')) {
    return true
  }
  reply.code(401).send({ error: 'human_gate_key_required' })
  return false
}

// HZ-179: a token may not mint, list or revoke tokens — a leaked token must
// not be able to extend its own life or hide itself. 403, not 401: the caller
// is authenticated, just with the wrong kind of credential.
function requireSession(request, reply) {
  if (request.auth?.via === 'session') return true
  reply.code(403).send({ error: 'session_required' })
  return false
}

// Who to record in the activity trail. Token-driven actions name the token
// too, so a script's changes are distinguishable from its owner's clicks.
function actorOf(request) {
  if (request.auth?.via === 'token') return `${request.user.name} (token: ${request.auth.tokenName})`
  return request.user.name
}

// The raw value of an `Authorization: Bearer <token>` header, or null.
function bearerToken(request) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization || '')
  return match ? match[1] : null
}

// Routes reachable without a login session: the auth routes themselves, the
// GitHub webhook (HMAC-verified, GitHub can't send a cookie), the farm
// callbacks (farmAuthorized, the farm's shared secret), the WhatsApp-approval
// leg (HZ-140 — its own WA_APPROVAL_SECRET plus a server-held approver
// allowlist; FARM_SHARED_SECRET gets a 401 there now), the shared stylesheet,
// and the deploy liveness probe (HZ-43 — nginx proxies /horizon/api/
// wholesale, so deploy.sh has no session to send; see /api/health below for
// what stays out of its payload).
//
// Exported for openapi-security-derived.test.mjs (HZ-178), which asserts the
// published spec declares the session cookie on exactly the routes that
// actually require one. openapi.js cannot import this file without a cycle, so
// the test reads the real list from here rather than keeping a second copy that
// could drift from the gate below.
export const SESSION_EXEMPT = [
  /^\/api\/auth\//,
  /^\/api\/webhooks\/github$/,
  /^\/api\/farm\//,
  /^\/api\/agent-pages\.css$/,
  /^\/api\/items\/[^/]+\/gates\/\d+\/approve-via-whatsapp$/,
  // HZ-142's poll-vote leg. Same credential and the same allowlist as the
  // line above — the bridge is a daemon and has no session either.
  /^\/api\/wa\/poll-vote$/,
  // HZ-274's WhatsApp kill switch: the concierge has no session either. Same
  // credential, and only the owner's jid is accepted.
  /^\/api\/projects\/autopilot-off-via-whatsapp$/,
  /^\/api\/health$/,
  // HZ-178: the generated API reference. Reachable like /api/health is, and for
  // the same reason — a published reference nobody can fetch is not published.
  // Its contents are route shapes only: no values, no examples, and the
  // credential-bearing internal routes are absent from it entirely.
  /^\/api\/openapi\.json$/,
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
  const data = `data: ${JSON.stringify(snapshot({ scope: 'enabled' }))}\n\n`
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
// `required` stays a literal below: it is not a length, so it does not belong in
// a file about field limits. Recorded in domain/README.md so the split is
// findable rather than rediscovered. The `priority` enum used to be named here
// as the other half of that split; HZ-135 moved it to domain/priorities.json, so
// the route now reads from two domain documents and one literal.
export const ITEM_BODY_PROPERTIES = Object.fromEntries(
  intakeFields().map((f) => [
    f.name,
    { type: 'string', ...(f.minLength === undefined ? {} : { minLength: f.minLength }), maxLength: f.maxLength },
  ]),
)

// The intake route's `priority` property, exported for the same reason
// ITEM_BODY_PROPERTIES is: server/test/api-priority-enum-derived.test.mjs diffs it
// against domain/priorities.json structurally, alongside a behavioural leg that
// posts every declared value through the real route.
//
// POST /api/items/:id/priority deliberately reuses only the `enum` and declares
// NO default — creating an item without naming a priority is normal, changing an
// item's priority to nothing is not, and that asymmetry predates HZ-135.
export const PRIORITY_PROPERTY = { type: 'string', enum: PRIORITIES, default: DEFAULT_PRIORITY }

// `onRoute` is a test seam (HZ-178). An onRoute hook only fires for routes
// registered after it, and every route below is registered before buildApp()
// returns — so a caller cannot install one from the outside, and Fastify exposes
// no authored schema afterwards (findRoute() returns the handler and params,
// nothing else). openapi-route-coverage-derived.test.mjs passes a collector here
// to read each route's declared params/querystring/body and check them against
// the published document; without it that gate could only assert the document
// agrees with itself. Production passes nothing and the hook is never added.
export function buildApp({ logger = true, onRoute = null } = {}) {
  const fastify = Fastify({ logger })

  if (onRoute) fastify.addHook('onRoute', onRoute)

  fastify.register(fastifyCookie)

  // HZ-178: the OpenAPI document is built from an `onRoute` hook, so that hook
  // has to exist BEFORE the first fastify.get() below. fastify.register()
  // defers plugin loading until ready(), by which point every route is already
  // registered and the generated spec comes out with an empty `paths` — that is
  // measured, not assumed. buildApp() is synchronous by contract (server.js
  // listens on its return value and ~20 server tests call it without await), so
  // the alternative — awaiting the registration, or moving all 47 route
  // registrations into a child plugin — would mean changing that contract or
  // reindenting this entire file.
  //
  // So the plugin body is invoked directly against this instance, which is what
  // fastify-plugin's wrapper would do with it anyway: it adds three hooks and
  // the `swagger` decorator, synchronously, then calls back (see
  // @fastify/swagger's lib/mode/dynamic.js). If a future version stops being
  // synchronous, openapi-route-coverage-derived.test.mjs fails naming every
  // missing route rather than quietly serving an empty document.
  fastifySwagger(fastify, swaggerOptions(), (err) => {
    if (err) throw err
  })

  // The session cookie (or, HZ-179, a bearer token) is declared on routes from
  // the same sessionExempt() the login gate below uses, rather than repeated in
  // 30-odd route schemas where it could drift from the gate that actually runs.
  // Routes that declare their own `security` keep it — that is the human-gate
  // PIN (HUMAN_GATE_SECURITY), the session-only /api/tokens routes, and the two
  // /api/auth routes which are exempt from the hook but check the session
  // themselves. Internal routes are absent from the spec, so they need no
  // security block at all.
  fastify.addHook('onRoute', (routeOptions) => {
    if (isInternal(routeOptions.url) || sessionExempt(routeOptions.url)) return
    if (routeOptions.schema?.security) return
    routeOptions.schema = { ...routeOptions.schema, security: API_SECURITY }
  })

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
  //
  // HZ-179: with no valid session, an `Authorization: Bearer` personal API
  // token is tried instead. The session path runs first and is unchanged. Every
  // bad token — malformed, unknown, expired, revoked — gets the same
  // invalid_token, so a caller cannot probe which case applies. request.auth
  // records which credential was used; humanAuthorized() and requireSession()
  // read it.
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || sessionExempt(request.url)) return
    const user = auth.getSessionUser(request.cookies[SESSION_COOKIE_NAME])
    if (user) {
      request.user = user
      request.auth = { via: 'session' }
      return
    }
    const raw = bearerToken(request)
    if (!raw) {
      reply.code(401).send({ error: 'login_required' })
      return
    }
    const tokenAuth = auth.getTokenAuth(raw)
    if (!tokenAuth) {
      reply.code(401).send({ error: 'invalid_token' })
      return
    }
    request.user = tokenAuth.user
    request.auth = { via: 'token', tokenId: tokenAuth.tokenId, tokenName: tokenAuth.tokenName }
  })

  // The response schema documents the media type only: this route hijacks the
  // reply, so the serializer never runs on it either way (HZ-178).
  const STREAM_DESCRIPTION =
    'A `data:` frame carrying the full board snapshot on every change, plus a `:ping` comment every 25s.'
  fastify.get(
    '/api/stream',
    { schema: { response: { 200: textResponse('text/event-stream', STREAM_DESCRIPTION) } } },
    (request, reply) => {
      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      reply.raw.write(`data: ${JSON.stringify(snapshot({ scope: 'enabled' }))}\n\n`)
      sseClients.add(reply.raw)
      request.raw.on('close', () => sseClients.delete(reply.raw))
    },
  )

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

  fastify.get('/api/items', { schema: { response: { 200: OK_OBJECT } } }, () => snapshot({ scope: 'enabled' }))

  // The generated API reference (HZ-178). fastify.swagger() is the decorator the
  // plugin installed at the top of buildApp(); it may only be called after
  // ready(), which a request by definition is.
  fastify.get('/api/openapi.json', { schema: { response: { 200: OK_OBJECT } } }, () => fastify.swagger())

  // Public liveness probe for deploy.sh (HZ-43): every /api/* route sits
  // behind the session gate above except this one, because nginx proxies
  // /horizon/api/ wholesale and deploy.sh has no session cookie to send. The
  // payload stays coarse on purpose — an ok flag and a row count, nothing
  // from a work item's contents — since anything exempted here is reachable
  // by anyone on the internet with no login. The count comes from a raw DB
  // query rather than store.listItems() so it can't silently start failing
  // again the way the old /api/items probe did (HZ-21 gated /api/items;
  // store.listItems() is also scoped by project, a second way an unrelated
  // app change could break this probe).
  fastify.get('/api/health', { schema: { response: { 200: OK_OBJECT, 503: ERROR_OBJECT } } }, (request, reply) => {
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
  fastify.get(
    '/api/agent-pages.css',
    { schema: { response: { 200: textResponse('text/css', 'Stylesheet shared by the standalone artifact, output and log pages.') } } },
    (request, reply) => {
      reply.type('text/css').send(PAGES_CSS)
    },
  )

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
        response: {
          200: textResponse('text/html', 'A standalone HTML page rendering the latest attempt’s artifact.'),
          404: ERROR_OBJECT,
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
        response: {
          200: textResponse('text/html', 'A standalone HTML page rendering that specific attempt’s artifact.'),
          404: ERROR_OBJECT,
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
        // Any other status here is farmd's own, relayed verbatim by the handler
        // below; declaring only the two this route decides itself keeps the
        // relayed bodies out of a serializer.
        response: { 200: OK_OBJECT, 503: ERROR_OBJECT },
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
        response: {
          200: textResponse('text/html', 'A standalone HTML page rendering the step’s raw agent output.'),
          404: ERROR_OBJECT,
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
        response: {
          200: textResponse('text/html', 'A standalone HTML page that live-tails the run by polling /api/runs/{runId}/log.'),
        },
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
            priority: PRIORITY_PROPERTY,
            // HZ-209: the WhatsApp wizard names the project when more than one
            // is enabled, rather than falling back to the active one.
            projectId: { type: 'integer' },
          },
        },
        response: { 200: OK_OBJECT, 400: ERROR_OBJECT, 502: ERROR_OBJECT },
      },
    },
    async (request, reply) => {
      const { title, outcome, metric, guardrails = '', priority = DEFAULT_PRIORITY, repo, projectId } = request.body
      // New work goes into an enabled project's repository (HZ-208); a named
      // project (HZ-209) must exist and be enabled and narrows the choice to
      // its own repositories — a disabled project is never acted on.
      if (projectId != null) {
        const named = store.listProjects().find((p) => p.id === projectId)
        if (!named?.enabled) return reply.code(400).send({ error: 'project_not_enabled' })
      }
      const connected = store
        .listRepos()
        .filter((r) => store.isProjectEnabled(r.project_id) && (projectId == null || r.project_id === projectId))
      if (repo && !connected.some((r) => r.repo === repo) && store.findRepo(repo)) {
        return reply.code(400).send({ error: 'That repository’s project is disabled' })
      }
      if (connected.length > 0) {
        const target = repo
          ? connected.find((r) => r.repo === repo) || null
          : connected.length === 1
            ? connected[0]
            : null
        if (!target) {
          return reply.code(400).send({ error: 'Pick which of the enabled projects’ repositories this work item belongs to' })
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
        return reply.code(400).send({ error: 'No enabled project has a connected repository — add one in Admin' })
      }
      const id = store.createLocalItem({ title, outcome, metric, guardrails, priority })
      return { ok: true, id }
    },
  )

  // The body for a performGateApproval {error, status} result. `premerge`
  // tells the UI the failure is the pre-merge check's — the reason is in the
  // activity log, so it must not open the PR on GitHub as if GitHub refused.
  const gateFailureBody = (result) => (result.premerge ? { error: result.error, premerge: true } : { error: result.error })

  // HZ-183: test-merge the PR head into the current base tip and run the
  // repo's checks there (server/src/premerge.js -> farm/premerge.py) before
  // the merge call. Resolves { headSha } when the merge may proceed with
  // exactly that head, or a performGateApproval error result. Every
  // inconclusive outcome blocks: this can only stop a merge, never make one.
  //
  // HZ-216: `token` is the item's premerge gate_action claim. Each error result
  // also carries `outcome` — what that row finishes as — which the routes do
  // not send (gateFailureBody picks error and premerge only).
  async function preMergeChecks(id, item, token) {
    const blocked = (text, error, outcome = { state: 'blocked', reason: error }) => {
      store.addEvent(id, {
        who: 'Horizon',
        text: `PR #${item.pr} is not merged and the gate stays open — ${text}`,
        color: '#9C333E',
        initials: 'HZ',
      })
      store.notifyChange()
      return { error, status: 502, premerge: true, outcome }
    }
    let head
    let baseSha
    try {
      head = await github.getPrHead(item)
      baseSha = await github.getBranchSha(item.repo, head.baseRef)
    } catch (err) {
      const error = `pre-merge check failed: ${err.message}`
      return blocked(`could not read the PR to test-merge it: ${err.message}`, error, { state: 'failed', reason: error })
    }
    // HZ-257: the test-merge would be the head itself, and the farm's own
    // checks already passed on exactly that head — no run, same merge pin.
    const skip = await tryPreMergeSkip(item, head, baseSha)
    if (skip) {
      store.setGateActionDetail(id, 'premerge', token, `checks already passed on ${skip.sha}, main unchanged`)
      store.addEvent(id, {
        who: 'Horizon',
        text: `pre-merge checks skipped for PR #${item.pr}: the repo's checks already passed on ${skip.sha} (${skip.source}, finished ${skip.finishedAt}) and ${head.baseRef} ${baseSha.slice(0, 12)} is already in that head, so a test-merge would re-test the same commit`,
        color: '#0E6E74',
        initials: 'HZ',
      })
      store.notifyChange()
      return { headSha: skip.sha, skipped: true }
    }
    store.setGateActionDetail(id, 'premerge', token, `running checks on ${head.baseRef} + PR #${item.pr}`)
    // Logged and pushed BEFORE the run: it takes minutes, and the human must
    // see that something is happening rather than click Accept again.
    store.addEvent(id, {
      who: 'Horizon',
      text: `running the repo's checks on a test-merge of ${head.baseRef} + PR #${item.pr} before merging — this takes a few minutes, don't click Accept again`,
      color: '#DFA200',
      initials: 'HZ',
    })
    store.notifyChange()
    let result
    try {
      result = await premerge.runPreMergeChecks(item, {
        headSha: head.sha,
        baseSha,
        timeoutMs: PREMERGE_CHECK_TIMEOUT_MS,
        // HZ-245: the repo's Admin-configured check commands, read now and
        // passed as argv, never env (see premerge.js). Null means auto-detect.
        checkCommands: store.getRepoCheckCommands(item.repo),
        // HZ-227: a run queued behind the check-slot limiter (farm/check_slots.py)
        // says so, rather than looking stuck. The token guard in
        // setGateActionDetail drops an event that lands after the row finished.
        onSlot: (name) => {
          const detail = name === 'queued' ? 'Waiting for a check slot' : 'Running checks'
          store.setGateActionDetail(id, 'premerge', token, detail)
        },
      })
    } catch (err) {
      // The runner promises never to reject; if it does, that is a crash, and
      // a crash blocks — fail closed, as for every other inconclusive result.
      result = { ok: false, reason: 'crash', detail: err.message, head_sha: head.sha, base_sha: baseSha }
    }
    if (!result.ok) {
      const error =
        result.reason === 'checks_failed'
          ? `pre-merge checks failed: ${result.failing_check}`
          : `pre-merge checks blocked the merge (${result.reason})`
      // blocked: the checks answered no; timed_out / failed: they gave no
      // answer. Only the check's name reaches the gate — never its output.
      const outcome =
        result.reason === 'checks_failed' || result.reason === 'merge_conflict'
          ? { state: 'blocked', reason: error, failingCheck: result.failing_check || null }
          : result.reason === 'timed_out'
            ? { state: 'timed_out', reason: `pre-merge checks did not finish: ${result.detail || 'timed out'}` }
            : { state: 'failed', reason: error }
      return blocked(premerge.describeFailure(result), error, outcome)
    }
    // The checks proved base_sha + head_sha. If the base moved meanwhile, the
    // squash would land on a main nobody tested — the HZ-154 x HZ-156 window.
    // Same source (GitHub) as the sha the check was given.
    let baseNow
    try {
      baseNow = await github.getBranchSha(item.repo, head.baseRef)
    } catch (err) {
      const error = `pre-merge check failed: ${err.message}`
      return blocked(`could not re-read ${head.baseRef} after the checks: ${err.message}`, error, { state: 'failed', reason: error })
    }
    if (baseNow !== result.base_sha) {
      return blocked(
        `${head.baseRef} moved from ${result.base_sha.slice(0, 12)} to ${baseNow.slice(0, 12)} while the checks ran, so the test-merge no longer matches what would land — click Accept again to re-test`,
        `${head.baseRef} moved while the pre-merge checks ran — click Accept again`,
      )
    }
    store.addEvent(id, {
      who: 'Horizon',
      text: `pre-merge checks passed on the test-merge of ${head.baseRef} ${result.base_sha.slice(0, 12)} + PR head ${result.head_sha.slice(0, 12)} (${result.note || 'green'})`,
      color: '#0E6E74',
      initials: 'HZ',
    })
    return { headSha: result.head_sha }
  }

  // HZ-257: { sha, finishedAt, source } when pre-merge may be skipped — a
  // fresh check_pass row for exactly this repo, item and head sha, the base tip
  // already an ancestor of that head, and the base still there on a re-read.
  // Null otherwise. Never throws: any doubt (no row, a git or API error, a
  // moved base) is null, which runs pre-merge exactly as before. The local
  // lookup goes first, so an item with no record never calls GitHub here.
  async function tryPreMergeSkip(item, head, baseSha) {
    if (!PREMERGE_SKIP_ENABLED) return null
    try {
      const pass = store.findCheckPass({ repo: item.repo, itemId: item.id, sha: head.sha, maxAgeMs: PREMERGE_SKIP_MAX_AGE_MS })
      if (!pass || pass.sha !== head.sha) return null
      if ((await github.isAncestor(item.repo, baseSha, head.sha)) !== true) return null
      if ((await github.getBranchSha(item.repo, head.baseRef)) !== baseSha) return null
      return pass
    } catch (err) {
      fastify.log.warn(`pre-merge skip not used for ${item.id}: ${err.message}`)
      return null
    }
  }

  // Shared by the session/gate-PIN browser route, the WhatsApp-concierge
  // route and the WhatsApp poll vote below — same merge/close/approve
  // sequence, only the actor label and the auth check at the call site
  // differ. Returns either a store.js-shaped result ({ok:true} /
  // {error:'not_found'|'not_at_gate'|'stale_step'}) or {error, status} for a
  // pre-merge/merge/close failure (502) or a pre-merge check already running
  // (409), which the routes send with that status.
  async function performGateApproval(id, stepIndex, notes, actor = 'You') {
    // Accepting the code means merging its PR — the gate does not advance if
    // the pre-merge checks or the merge fail, and the reason is logged to the
    // item's activity.
    const item = store.getItem(id)
    if (
      item &&
      item.cursor === stepIndex &&
      STEPS[stepIndex]?.label === 'Accept the code' &&
      item.pr != null &&
      item.repo
    ) {
      // HZ-216: the item's premerge gate_action row is the lock — a fast 409
      // for the double click, from any tab or WhatsApp, that also holds across
      // a restart (farm/premerge.py's per-item file lock is the other mutex).
      // The same row is what every client shows while the run goes.
      //
      // HZ-250: no new run while a self-deploy drains. Checked in the same
      // tick as the claim, so a run either is refused or is in the drain's list.
      if (deployDrain.isDeployBlocked()) return { error: deployDrain.DEPLOY_BLOCK_MESSAGE, status: 409, premerge: true }
      const claim = store.claimGateAction(id, 'premerge', {
        detail: `reading PR #${item.pr}`,
        timeoutMs: PREMERGE_CHECK_TIMEOUT_MS,
      })
      if (!claim) {
        const running = store.getGateAction(id, 'premerge')
        const orphaned = running?.startedBeforeRestart
          ? ` (they started before the server restarted — the gate re-opens by ${running.deadline})`
          : ''
        return { error: `pre-merge checks are already running for this item — wait for them to finish${orphaned}`, status: 409, premerge: true }
      }
      let outcome = { state: 'failed', reason: 'pre-merge checks stopped unexpectedly' }
      try {
        const gate = await preMergeChecks(id, item, claim.token)
        if (gate.error) {
          outcome = gate.outcome
          return gate
        }
        // HZ-257: a skipped run keeps its "checks already passed on <sha>"
        // detail through to merged — don't overwrite it here.
        if (!gate.skipped) store.setGateActionDetail(id, 'premerge', claim.token, `checks passed, merging PR #${item.pr}`)
        try {
          await github.mergePr(item, { sha: gate.headSha })
          outcome = { state: 'merged' }
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
          outcome = { state: 'failed', reason: `merge failed: ${err.message}` }
          return { error: `merge failed: ${err.message}`, status: 502 }
        }
      } finally {
        store.finishGateAction(id, 'premerge', claim.token, outcome)
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

  // The /reject body, moved out unchanged (HZ-271) so every send-back — the
  // browser, the WhatsApp poll vote and the Autopilot caretaker — runs it.
  function performSendBack(id, { target, feedback, targetStepIndex } = {}, actor = 'You') {
    return store.requestChanges(id, target, feedback, actor, targetStepIndex ?? null)
  }

  // HZ-271: THE one approve and the one send-back. Every route below calls
  // these through this object, looked up at call time, and caretakerActor.js
  // is handed the same object (server.js) rather than importing anything that
  // can act — so the caretaker runs exactly the checks a human click runs
  // (gate state, review-cycle cap, step status), minus only the route's
  // humanAuthorized() wrapper. Decorated so server.js and the tests reach it.
  // HZ-272: resolveConflicts is the Resolve-conflicts button's run, for the
  // caretaker at Accept the code (caretakerAccept.js).
  const gateActions = {
    approve: (id, stepIndex, notes, actor) => performGateApproval(id, stepIndex, notes, actor),
    sendBack: (id, opts, actor) => performSendBack(id, opts, actor),
    resolveConflicts: (id, actor, opts) => orchestrator.resolveConflicts(id, actor, opts),
  }
  fastify.decorate('gateActions', gateActions)

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
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT, 502: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { id, stepIndex } = request.params
      const notes = (request.body?.notes || '').trim()
      const result = await gateActions.approve(id, stepIndex, notes, actorOf(request))
      if (result.status) return reply.code(result.status).send(gateFailureBody(result))
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
      const result = await gateActions.approve(id, stepIndex, notes, actor)
      if (result.status) return reply.code(result.status).send(gateFailureBody(result))
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
          approve: (id, stepIndex, notes, actor) => gateActions.approve(id, stepIndex, notes, actor),
          // targetStepIndex stays null: store.requestChanges derives the
          // default rework target itself, Accept-gate exception included. A
          // second derivation here could only ever drift from that one.
          sendBack: (id, feedback, actor) =>
            gateActions.sendBack(id, { target: STEPS[store.getItem(id)?.cursor]?.label || null, feedback }, actor),
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
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      return send(
        reply,
        gateActions.sendBack(
          request.params.id,
          {
            target: request.body?.target,
            feedback: request.body?.feedback,
            targetStepIndex: request.body?.targetStepIndex,
          },
          actorOf(request),
        ),
      )
    },
  )

  // HZ-92/HZ-154: merge-conflict resolution — same gate PIN requirement as
  // /reject above (this is the fast path that replaces sending the item
  // straight back to the implement step), the Accept gate itself is untouched
  // either way. HZ-154 let the farm side resolve the conflicted hunks and
  // review just that resolution, so this can now involve an agent; what it
  // can do here did not change — it resolves or it escalates, and the gate and
  // its PIN are never approved or bypassed by either outcome.
  fastify.post(
    '/api/items/:id/resolve-conflicts',
    {
      schema: {
        params: idParam,
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const result = await gateActions.resolveConflicts(request.params.id, actorOf(request))
      return send(reply, result)
    },
  )

  // HZ-185: forward an item the latest automated review just rejected to
  // Accept the code, with that failing verdict attached — the same path the
  // review cap takes. Same gate PIN as /reject: it never approves anything, it
  // only moves the item to the gate, where Accept still needs the PIN.
  fastify.post(
    '/api/items/:id/forward-to-accept',
    {
      schema: {
        params: idParam,
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      return send(reply, await orchestrator.forwardRejectedReview(request.params.id, request.user.name))
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
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
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
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
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
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
      },
    },
    (request, reply) => send(reply, store.addDependency(request.params.id, request.body.dependsOnId, actorOf(request))),
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
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
      },
    },
    (request, reply) => send(reply, store.removeDependency(request.params.id, request.body.dependsOnId, actorOf(request))),
  )

  // Confirm/override one agent's specialist persona (the PM proposes the Eng
  // one at intake). Personas are agent-scoped (HZ-125), so both halves are
  // required: an unknown agent 400s at the schema layer, and an id that isn't
  // in THAT agent's bucket is refused by store.setPersona's bad_persona (409,
  // like every other store-level refusal) — a conditional enum per agent isn't
  // cheap to express here, so that half of the validation lives one level down.
  // The next dispatch reads the item.
  fastify.post(
    '/api/items/:id/persona',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['agent', 'persona'],
          properties: {
            agent: { type: 'string', enum: Object.keys(PERSONAS) },
            persona: { type: 'string', maxLength: 100 },
          },
        },
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
      },
    },
    (request, reply) => send(reply, store.setPersona(request.params.id, request.body.agent, request.body.persona)),
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
          properties: { priority: { type: 'string', enum: PRIORITIES } },
        },
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
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
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      return send(
        reply,
        store.restartPhase(request.params.id, request.params.phase, request.body?.reason, actorOf(request)),
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
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { id } = request.params
      const item = store.getItem(id)
      const result = store.abandonItem(id, request.body.reason, actorOf(request))
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
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT },
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
  fastify.get(
    '/api/auth/google/start',
    { schema: { response: { 302: noContent('Redirect to Google’s consent screen, or back to the UI with ?error= when SSO is not configured.') } } },
    (request, reply) => {
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
    },
  )

  fastify.get(
    '/api/auth/google/callback',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { code: { type: 'string' }, state: { type: 'string' } },
        },
        response: { 302: noContent('Redirect to the UI — logged in on success, with ?error= on every rejection.') },
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

  fastify.post('/api/auth/logout', { schema: { response: { 200: OK_OBJECT } } }, (request, reply) => {
    auth.deleteSession(request.cookies[SESSION_COOKIE_NAME])
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    return { ok: true }
  })

  // The two routes below sit under /api/auth/ and so are exempt from the
  // onRequest login gate, but each checks the session itself and 401s without
  // one — hence `security` declared here rather than left to the hook that
  // reads sessionExempt() (HZ-178).
  fastify.get(
    '/api/auth/me',
    { schema: { response: { 200: OK_OBJECT, 401: ERROR_OBJECT }, security: SESSION_SECURITY } },
    (request, reply) => {
      const user = auth.getSessionUser(request.cookies[SESSION_COOKIE_NAME])
      if (!user) return reply.code(401).send({ error: 'login_required' })
      return { user }
    },
  )

  // Requires only a login session (not the PIN itself) — regenerating your
  // own PIN can't be gated behind the PIN it's replacing.
  fastify.post(
    '/api/auth/gate-pin/regenerate',
    { schema: { response: { 200: OK_OBJECT, 401: ERROR_OBJECT }, security: SESSION_SECURITY } },
    (request, reply) => {
      const user = auth.getSessionUser(request.cookies[SESSION_COOKIE_NAME])
      if (!user) return reply.code(401).send({ error: 'login_required' })
      return { ok: true, pin: auth.regenerateGatePin(user.id) }
    },
  )

  // ---- personal API tokens (HZ-179) ----
  // Managed from Admin with a browser session only (requireSession). The raw
  // token is in the 201 body of POST and nowhere else, ever.

  const TOKEN_ROUTE_RESPONSES = { 401: ERROR_OBJECT, 403: ERROR_OBJECT }

  fastify.get(
    '/api/tokens',
    { schema: { response: { 200: OK_OBJECT, ...TOKEN_ROUTE_RESPONSES }, security: SESSION_SECURITY } },
    (request, reply) => {
      if (!requireSession(request, reply)) return
      return { tokens: auth.listApiTokens(request.user.id) }
    },
  )

  fastify.post(
    '/api/tokens',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            // At least one visible character, no control characters: the name
            // lands in the activity trail's `who` on every token action.
            name: { type: 'string', minLength: 1, maxLength: 60, pattern: '^[^\\u0000-\\u001f\\u007f]*\\S[^\\u0000-\\u001f\\u007f]*$' },
            expiresInDays: {
              type: 'integer',
              minimum: 1,
              maximum: auth.API_TOKEN_MAX_DAYS,
              default: auth.API_TOKEN_DEFAULT_DAYS,
            },
          },
        },
        response: { 201: OK_OBJECT, 400: ERROR_OBJECT, ...TOKEN_ROUTE_RESPONSES },
        security: SESSION_SECURITY,
      },
    },
    (request, reply) => {
      if (!requireSession(request, reply)) return
      const created = auth.createApiToken(request.user.id, request.body.name.trim(), request.body.expiresInDays)
      return reply.code(201).send(created)
    },
  )

  fastify.delete(
    '/api/tokens/:id',
    { schema: { params: idParam, response: { 200: OK_OBJECT, 404: ERROR_OBJECT, ...TOKEN_ROUTE_RESPONSES }, security: SESSION_SECURITY } },
    (request, reply) => {
      if (!requireSession(request, reply)) return
      if (!auth.revokeApiToken(request.user.id, request.params.id)) return reply.code(404).send({ error: 'token_not_found' })
      return { ok: true }
    },
  )

  // ---- agent definitions (HZ-9: hierarchical, git-versioned, UI-editable) ----

  fastify.get('/api/definitions', { schema: { response: { 200: OK_OBJECT } } }, () => definitions.listDefinitions())

  // Static segment registered alongside /:kind/:name — Fastify prefers it.
  fastify.get(
    '/api/definitions/effective',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            role: { type: 'string', maxLength: 100 },
            // agent selects the persona bucket (HZ-125) — a persona id is only
            // unique within one agent.
            agent: { type: 'string', maxLength: 100 },
            persona: { type: 'string', maxLength: 100 },
            project: { type: 'string', maxLength: 200 },
            repo: { type: 'string', maxLength: 300 },
          },
        },
        response: { 200: OK_OBJECT },
      },
    },
    // HZ-246: the served DB rules ride in as overrides, so the preview is what
    // an agent dispatched now would get.
    (request) => ({
      prompt: definitions.effectivePrompt({
        ...request.query,
        overrides: rulesStore.servedRulesFor(request.query.project, request.query.repo),
      }),
    }),
  )

  const definitionParams = {
    type: 'object',
    required: ['kind', 'name'],
    properties: { kind: { type: 'string' }, name: { type: 'string', maxLength: 200 } },
  }

  fastify.get(
    '/api/definitions/:kind/:name',
    { schema: { params: definitionParams, response: { 200: OK_OBJECT, 404: ERROR_OBJECT } } },
    (request, reply) => {
      const def = definitions.readDefinition(request.params.kind, request.params.name)
      if (!def) return reply.code(404).send({ error: 'unknown_definition' })
      return def
    },
  )

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
        response: {
          200: OK_OBJECT,
          400: ERROR_OBJECT,
          401: ERROR_OBJECT,
          404: ERROR_OBJECT,
          409: ERROR_OBJECT,
          502: ERROR_OBJECT,
        },
        security: HUMAN_GATE_SECURITY,
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { kind, name } = request.params
      const actor = actorOf(request)
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

  // ---- project and repo rules (HZ-246: DB versions over the .md defaults) ----
  // Saving and restoring are gate-grade (session + gate PIN, checked before
  // anything is read or written); the PIN is only ever passed to
  // humanAuthorized, never logged or echoed. History is append-only: restore
  // inserts a new version. The .md files are never written from here.

  const ruleParams = {
    type: 'object',
    required: ['scope', 'key'],
    properties: { scope: { type: 'string', maxLength: 20 }, key: { type: 'string', maxLength: 300 } },
  }

  function ruleTarget(request, reply) {
    const { scope, key } = request.params
    if (!rulesStore.isRuleScope(scope)) {
      reply.code(400).send({ error: 'bad_scope' })
      return null
    }
    if (!rulesStore.isRuleKey(scope, key)) {
      reply.code(400).send({ error: 'bad_key' })
      return null
    }
    return { scope, key }
  }

  const RULES_ERROR_STATUS = {
    bad_key: 400,
    bad_content: 400,
    rules_too_large: 400,
    credential_pattern: 400,
    unknown_version: 404,
    unverified_version: 409,
    rules_secret_not_configured: 503,
  }

  function rulesError(err, reply) {
    if (!(err instanceof rulesStore.RulesError) || !Object.hasOwn(RULES_ERROR_STATUS, err.code)) throw err
    const body = { error: err.code }
    if (err.limit !== undefined) body.limit = err.limit
    if (err.matches !== undefined) body.matches = err.matches
    return reply.code(RULES_ERROR_STATUS[err.code]).send(body)
  }

  // Every project and repo whose rules the owner can edit: those with a
  // rules file, plus DB projects and connected repos that have none.
  function ruleTargets(scope, fileDefs, named) {
    const byKey = new Map()
    for (const def of fileDefs) {
      byKey.set(def.name, { scope, key: def.name, label: scope === 'repo' ? def.name.replace('__', '/') : def.name, file: true })
    }
    for (const name of named) {
      const key = definitions.rulesKey(scope, name)
      if (!rulesStore.isRuleKey(scope, key)) continue
      byKey.set(key, { scope, key, label: name, file: byKey.has(key) })
    }
    return [...byKey.values()]
      .map((target) => ({ ...target, versions: rulesStore.listRuleVersions(scope, target.key).length }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  fastify.get('/api/rules/targets', { schema: { response: { 200: OK_OBJECT } } }, () => {
    const files = definitions.listDefinitions()
    return {
      projects: ruleTargets('project', files.projects, store.listProjects({ checks: false }).map((p) => p.name)),
      repos: ruleTargets('repo', files.repos, store.listRepos().map((r) => r.repo)),
    }
  })

  fastify.get(
    '/api/rules/:scope/:key/versions',
    { schema: { params: ruleParams, response: { 200: OK_OBJECT, 400: ERROR_OBJECT } } },
    (request, reply) => {
      const target = ruleTarget(request, reply)
      if (!target) return
      const file = definitions.readDefinition(target.scope, target.key)
      return {
        ...target,
        default: { exists: !!file, path: file?.path ?? null, content: file?.content ?? '' },
        served_version: rulesStore.servedVersion(target.scope, target.key),
        versions: rulesStore.listRuleVersions(target.scope, target.key),
      }
    },
  )

  fastify.post(
    '/api/rules/:scope/:key',
    {
      schema: {
        params: ruleParams,
        body: {
          type: 'object',
          required: ['content'],
          properties: { content: { type: 'string', maxLength: 20000 } },
        },
        response: { 200: OK_OBJECT, 400: ERROR_OBJECT, 401: ERROR_OBJECT, 503: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const target = ruleTarget(request, reply)
      if (!target) return
      try {
        return { ok: true, version: rulesStore.saveRule(target.scope, target.key, request.body.content, actorOf(request)) }
      } catch (err) {
        return rulesError(err, reply)
      }
    },
  )

  fastify.post(
    '/api/rules/:scope/:key/versions/:version/restore',
    {
      schema: {
        params: {
          type: 'object',
          required: ['scope', 'key', 'version'],
          properties: { ...ruleParams.properties, version: { type: 'integer', minimum: 1 } },
        },
        response: { 200: OK_OBJECT, 400: ERROR_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT, 503: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const target = ruleTarget(request, reply)
      if (!target) return
      try {
        return {
          ok: true,
          version: rulesStore.restoreRule(target.scope, target.key, request.params.version, actorOf(request)),
        }
      } catch (err) {
        return rulesError(err, reply)
      }
    },
  )

  // ---- Deploy targets (HZ-41, read-only) ----
  // The targets are rows in the deploy_target table (HZ-263) — this endpoint
  // only surfaces each target's on-disk deploy state for the Admin page.

  fastify.get('/api/admin/deploy-targets', { schema: { response: { 200: OK_OBJECT } } }, () => ({
    targets: deploy.listTargetStatuses(),
  }))

  // HZ-258: a target's Dry run — five read-only checks (deployDryRun.js). PIN
  // first, before the row is even looked up. The body must be empty: what is
  // probed comes only from the stored row, never from the request.
  fastify.post(
    '/api/admin/deploy-targets/:key/dry-run',
    {
      schema: {
        params: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' } },
        },
        body: { type: 'object', maxProperties: 0 },
        response: { 200: OK_OBJECT, 400: ERROR_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
        security: HUMAN_GATE_SECURITY,
      },
    },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { key } = request.params
      const target = findTargetByKey(key)
      if (!target) return reply.code(404).send({ error: 'deploy_target_not_found' })
      if (!deployDryRun.tryBeginDryRun(key)) return reply.code(409).send({ error: 'dry_run_in_progress' })
      try {
        const ranAt = new Date().toISOString()
        const results = await deployDryRun.runDryRun(target)
        request.log.info({ key, pass: results.map((r) => r.pass) }, 'deploy target dry run')
        return { key, ranAt, results }
      } finally {
        deployDryRun.endDryRun(key)
      }
    },
  )

  // HZ-259: Admin create / edit / delete of deploy targets. The schema checks
  // shape only; every rule (script inside infra/host, services the sudoers file
  // permits) is checkRunnable's, run by the deployTargets.js writers. PIN
  // first on every write, before any lookup; the body is never logged.

  const DEPLOY_TARGET_KEY = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }
  const DEPLOY_TARGET_FIELDS = {
    type: 'object',
    additionalProperties: false,
    required: ['repo', 'script', 'service', 'repoDir', 'stateKey', 'healthUrl', 'healthCheckType'],
    properties: {
      repo: { type: 'string', maxLength: 300, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      script: { type: 'string', minLength: 1, maxLength: 300 },
      service: { type: 'string', minLength: 1, maxLength: 300 },
      repoDir: { type: 'string', minLength: 1, maxLength: 300 },
      stateKey: { type: 'string', minLength: 1, maxLength: 300 },
      healthUrl: { type: 'string', minLength: 1, maxLength: 300 },
      healthCheckType: { type: 'string', minLength: 1, maxLength: 300 },
      extraServices: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } },
    },
  }
  const DEPLOY_TARGET_WRITE_RESPONSES = {
    400: ERROR_OBJECT,
    401: ERROR_OBJECT,
    404: ERROR_OBJECT,
    409: ERROR_OBJECT,
  }
  const DEPLOY_TARGET_ERROR = {
    invalid: [400, 'deploy_target_invalid'],
    conflict: [409, 'deploy_target_conflict'],
    not_found: [404, 'deploy_target_not_found'],
  }

  function deployTargetResult(request, reply, result, action, okCode = 200) {
    if (!result.ok) {
      const [status, error] = DEPLOY_TARGET_ERROR[result.code]
      return reply.code(status).send(result.reason ? { error, reason: result.reason } : { error })
    }
    request.log.info({ key: request.params?.key ?? request.body.key, action, actor: actorOf(request) }, 'deploy target changed')
    return reply.code(okCode).send(result.target ? { ok: true, target: result.target } : { ok: true })
  }

  // The stored rows (script, repoDir, health URL…) for the overrides panel.
  // Rows hold no tokens or env values.
  fastify.get('/api/admin/deploy-targets/config', { schema: { response: { 200: OK_OBJECT } } }, () => ({
    targets: listTargets(),
  }))

  fastify.post(
    '/api/admin/deploy-targets',
    {
      schema: {
        body: {
          ...DEPLOY_TARGET_FIELDS,
          required: ['key', ...DEPLOY_TARGET_FIELDS.required],
          properties: { key: DEPLOY_TARGET_KEY, ...DEPLOY_TARGET_FIELDS.properties },
        },
        response: { 201: OK_OBJECT, ...DEPLOY_TARGET_WRITE_RESPONSES },
        security: HUMAN_GATE_SECURITY,
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const result = createTarget(targetFromBody(request.body.key, request.body))
      return deployTargetResult(request, reply, result, 'create', 201)
    },
  )

  fastify.put(
    '/api/admin/deploy-targets/:key',
    {
      schema: {
        params: { type: 'object', required: ['key'], properties: { key: DEPLOY_TARGET_KEY } },
        body: DEPLOY_TARGET_FIELDS,
        response: { 200: OK_OBJECT, ...DEPLOY_TARGET_WRITE_RESPONSES },
        security: HUMAN_GATE_SECURITY,
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      return deployTargetResult(request, reply, updateTarget(request.params.key, request.body), 'update')
    },
  )

  fastify.delete(
    '/api/admin/deploy-targets/:key',
    {
      schema: {
        params: { type: 'object', required: ['key'], properties: { key: DEPLOY_TARGET_KEY } },
        response: { 200: OK_OBJECT, ...DEPLOY_TARGET_WRITE_RESPONSES },
        security: HUMAN_GATE_SECURITY,
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      return deployTargetResult(request, reply, deleteTarget(request.params.key), 'delete')
    },
  )

  // ---- GitHub sync configuration (from the UI) ----

  fastify.get('/api/sync/status', { schema: { response: { 200: OK_OBJECT } } }, () => github.getSyncState())

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
        response: { 200: OK_OBJECT, 400: ERROR_OBJECT },
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
        response: { 200: OK_OBJECT, 409: ERROR_OBJECT },
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
        response: { 200: OK_OBJECT, 400: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
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
      // HZ-244: set up the repo's GitHub webhook. Never fails the connect — the
      // outcome rides along as `webhook` for Admin to show.
      const webhook = await webhooks.ensure(canonical).catch(() => ({ status: 'error', lastResponseCode: null, reason: null }))
      broadcast()
      return { ...result, webhook }
    },
  )

  // HZ-244: each connected repo's webhook status, read live from GitHub's hooks
  // API. Read-only — one GET per repo; a failure is that row's `error`, never a
  // 5xx for the list.
  fastify.get(
    '/api/projects/:id/repos/webhooks',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT },
      },
    },
    async (request, reply) => {
      const project = store.listProjects().find((p) => p.id === request.params.id)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const settled = await Promise.allSettled(project.repos.map((r) => webhooks.inspect(r.repo)))
      return {
        webhooks: project.repos.map((r, i) => ({
          repo: r.repo,
          ...(settled[i].status === 'fulfilled'
            ? settled[i].value
            : { status: 'error', lastResponseCode: null, reason: null }),
        })),
      }
    },
  )

  // HZ-244: Fix webhook — creates a missing hook (POST) or repairs our own
  // mismatched one (PATCH on its id). Gate-PIN protected like every Admin
  // write, checked before any lookup so a bad PIN never reaches GitHub.
  fastify.post(
    '/api/projects/:id/repos/webhook/fix',
    {
      schema: {
        security: HUMAN_GATE_SECURITY,
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
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 502: ERROR_OBJECT, 503: ERROR_OBJECT },
      },
    },
    async (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const project = store.listProjects().find((p) => p.id === request.params.id)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const repo = project.repos.find((r) => r.repo === request.body.repo)?.repo
      if (!repo) return reply.code(404).send({ error: 'That repository is not connected to this project' })
      const { action, status, lastResponseCode, reason, httpStatus } = await webhooks.fix(repo)
      if (status === 'error') {
        if (reason === 'secret_not_configured') return reply.code(503).send({ error: 'webhook_secret_not_configured' })
        if (reason === 'webhook_url_not_public') return reply.code(503).send({ error: 'webhook_url_not_public' })
        request.log.warn({ repo, httpStatus }, 'webhook fix failed')
        return reply.code(502).send({ error: httpStatus ? `GitHub returned ${httpStatus}` : 'GitHub could not be reached' })
      }
      request.log.info({ repo, action }, 'webhook fixed')
      return { ok: true, repo, action, webhook: { status, lastResponseCode, reason } }
    },
  )

  // Activate a project. Activate only — it never enables the project (HZ-208).
  // No farm restart and no cancel — `restarting` stays in the body, always false.
  fastify.post(
    '/api/projects/:id/activate',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT },
      },
    },
    (request, reply) => {
      const project = store.listProjects().find((p) => p.id === request.params.id)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      if (project.id === getActiveProjectId()) {
        return { ok: true, alreadyActive: true }
      }
      setSetting('active_project_id', String(project.id))
      broadcast()
      return { ok: true, restarting: false }
    },
  )

  // HZ-207: turn a project's dispatch on or off. A flag write only — no farm
  // restart, and no step in any project is cancelled or re-queued. HZ-208:
  // gate-PIN protected, checked before the project lookup so a bad PIN never
  // touches state.
  fastify.post(
    '/api/projects/:id/enabled',
    {
      schema: {
        security: HUMAN_GATE_SECURITY,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT, 409: ERROR_OBJECT },
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const project = store.listProjects().find((p) => p.id === request.params.id)
      if (!project) return reply.code(404).send({ error: 'Project not found' })
      const result = orchestrator.setProjectEnabled(project.id, request.body.enabled, request.log)
      if (result.error) return reply.code(409).send({ error: result.error })
      broadcast()
      return result
    },
  )

  // HZ-270: a project's Autopilot mode. Gate-PIN protected exactly like
  // /enabled, checked before the lookup so a bad PIN never touches state. A
  // flag write only: no gate, PR or GitHub path runs from here.
  fastify.post(
    '/api/projects/:id/autopilot',
    {
      schema: {
        security: HUMAN_GATE_SECURITY,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        body: {
          type: 'object',
          required: ['mode'],
          additionalProperties: false,
          properties: { mode: { type: 'string', enum: store.AUTOPILOT_MODES } },
        },
        response: { 200: OK_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT },
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const result = store.setProjectAutopilot(request.params.id, request.body.mode, actorOf(request))
      if (result.error) return reply.code(404).send({ error: 'Project not found' })
      broadcast()
      return { ok: true, projectId: request.params.id, old: result.old, new: result.new, ...(result.unchanged ? { unchanged: true } : {}) }
    },
  )

  // HZ-274: the WhatsApp kill switch. The concierge forwards
  // 'autopilot off <project>' here; turning Autopilot on or to shadow stays
  // Admin + PIN only. There is no mode field — this route can only write
  // 'off' — and a body naming any other key is a 400.
  //
  // The 503/401/403 ladder runs before the project lookup, the same helpers
  // in the same order as approve-via-whatsapp, so a non-owner gets one
  // identical refusal whether or not the project exists and learns nothing
  // about its setting. 404 is reachable by the owner only.
  fastify.post(
    '/api/projects/autopilot-off-via-whatsapp',
    {
      schema: {
        body: {
          type: 'object',
          required: ['project', 'senderJid'],
          // propertyNames, not additionalProperties: false — Fastify's ajv
          // silently strips unknown keys under the latter, and a body that
          // tries to carry a mode, PIN or rules must be refused outright.
          propertyNames: { enum: ['project', 'senderJid'] },
          properties: {
            project: { type: 'string', minLength: 1, maxLength: 200 },
            senderJid: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    (request, reply) => {
      if (!approvalSecretConfigured()) return reply.code(503).send({ error: 'wa_approval_not_configured' })
      if (!approvalSecretOk(request.headers['x-wa-approval-secret'])) {
        return reply.code(401).send({ error: 'bad_approval_secret' })
      }
      if (!isOwner(request.body.senderJid)) return reply.code(403).send({ error: 'refused' })
      const project = store.findProjectByName(request.body.project)
      if (!project) return reply.code(404).send({ error: 'project_not_found' })
      // The audit row records the source; no jid is stored.
      const result = store.setProjectAutopilot(project.id, 'off', 'Owner via WhatsApp')
      if (result.error) return reply.code(404).send({ error: 'project_not_found' })
      broadcast()
      return { ok: true, project: project.name, old: result.old, new: result.new, ...(result.unchanged ? { unchanged: true } : {}) }
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
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT },
      },
    },
    (request, reply) => {
      const result = store.removeRepoFromProject(request.params.id, request.body.repo)
      if (result.error) return reply.code(404).send({ error: 'That repository is not connected to this project' })
      broadcast()
      return result
    },
  )

  // HZ-245: a repo's check commands (install, test, lint, e2e). Gate-PIN
  // protected and browser-session only, like a gate: these commands judge
  // every agent's work, so no API token or agent may write them. Checked
  // before the repo lookup so a bad PIN never touches state. Reading them
  // needs only a login — they ride on snapshot()'s projects.
  const CHECK_COMMAND_SCHEMA = { type: 'string', maxLength: 2000 }
  fastify.put(
    '/api/projects/:id/repos/checks',
    {
      schema: {
        security: HUMAN_GATE_SECURITY,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        body: {
          type: 'object',
          required: ['repo'],
          additionalProperties: false,
          properties: {
            repo: { type: 'string', minLength: 1, maxLength: 300 },
            install: CHECK_COMMAND_SCHEMA,
            test: CHECK_COMMAND_SCHEMA,
            lint: CHECK_COMMAND_SCHEMA,
            e2e: CHECK_COMMAND_SCHEMA,
          },
        },
        response: { 200: OK_OBJECT, 400: ERROR_OBJECT, 401: ERROR_OBJECT, 404: ERROR_OBJECT },
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { repo, ...checks } = request.body
      const result = store.setRepoCheckCommands(request.params.id, repo, checks)
      if (result.error) return reply.code(404).send({ error: 'That repository is not connected to this project' })
      broadcast()
      return { ok: true, repo, checks: result.checks }
    },
  )

  // HZ-245: Admin's placeholders — what auto-detection would run for the repo.
  fastify.get(
    '/api/projects/:id/repos/check-defaults',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        querystring: {
          type: 'object',
          required: ['repo'],
          properties: { repo: { type: 'string', minLength: 1, maxLength: 300 } },
        },
        response: { 200: OK_OBJECT, 404: ERROR_OBJECT },
      },
    },
    async (request, reply) => {
      const project = store.listProjects().find((p) => p.id === request.params.id)
      if (!project?.repos.some((r) => r.repo === request.query.repo)) {
        return reply.code(404).send({ error: 'That repository is not connected to this project' })
      }
      return { repo: request.query.repo, ...(await orchestrator.fetchCheckDefaults(request.query.repo)) }
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

  // HZ-250: the deploy-drain routes are called only by deploy-horizon.sh on
  // this host (infra/host/deploy-drain.mjs). nginx proxies /horizon/api/ and
  // always sets x-forwarded-for, so a proxied request is refused even from
  // loopback. The socket peer, not request.ip, which trustProxy would change.
  const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  function loopbackOnly(request, reply) {
    if (!LOOPBACK_PEERS.has(request.socket?.remoteAddress) || request.headers['x-forwarded-for'] !== undefined) {
      reply.code(403).send({ error: 'loopback only' })
      return false
    }
    return true
  }
  const drainAuthorized = (request, reply) => loopbackOnly(request, reply) && farmAuthorized(request, reply)
  const DRAIN_KINDS = ['premerge', 'resolve']

  // Starts (or extends) the block on new pre-merge and resolve runs and lists
  // the running ones. Validated by hand: Fastify's schema coercion would
  // accept "30" as an integer.
  fastify.post('/api/farm/deploy-drain', (request, reply) => {
    if (!drainAuthorized(request, reply)) return
    const ttlS = request.body?.ttl_s
    if (!Number.isInteger(ttlS) || ttlS < 0) return reply.code(400).send({ error: 'ttl_s must be a non-negative integer' })
    return deployDrain.beginDrain({ ttlS })
  })

  fastify.get('/api/farm/deploy-drain', (request, reply) => {
    if (!drainAuthorized(request, reply)) return
    return deployDrain.drainStatus()
  })

  fastify.post('/api/farm/deploy-drain/interrupt', async (request, reply) => {
    if (!drainAuthorized(request, reply)) return
    const runs = request.body?.runs
    const valid =
      Array.isArray(runs) &&
      runs.every(
        (run) =>
          run !== null &&
          typeof run === 'object' &&
          typeof run.itemId === 'string' &&
          run.itemId !== '' &&
          DRAIN_KINDS.includes(run.kind),
      )
    if (!valid) return reply.code(400).send({ error: 'runs must be an array of {itemId, kind: premerge|resolve}' })
    const result = await deployDrain.interruptForDeploy(runs.map(({ itemId, kind }) => ({ itemId, kind })))
    for (const { itemId, kind, killed } of result.interrupted) {
      const outcome =
        kind === 'resolve'
          ? killed ? 'resolver stopped' : 'resolver not confirmed stopped'
          : killed ? 'checker stopped' : 'no checker process tracked'
      request.log.warn(`self-deploy: interrupted ${kind} run of ${itemId} (${outcome})`)
    }
    return result
  })

  fastify.delete('/api/farm/deploy-drain', (request, reply) => {
    if (!drainAuthorized(request, reply)) return
    deployDrain.endDrain()
    return { blocked: false }
  })

  // The snapshot the WhatsApp concierge renders into its replies. It is a
  // daemon with no browser session, so it cannot use /api/items — HZ-21 gated
  // that route and the concierge has 401'd on every message since. Served
  // here rather than by exempting /api/items, because nginx proxies
  // /horizon/api/ wholesale: anything in SESSION_EXEMPT is reachable from the
  // internet with no login, and /api/items carries every work item's full
  // contents. This sits behind the farm's own shared-secret boundary instead.
  //
  // HZ-209: farmd asks for ?scope=enabled, the items of every enabled project.
  // The default stays the active project's view.
  fastify.get(
    '/api/farm/snapshot',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['active', 'enabled'], default: 'active' } },
        },
      },
    },
    (request, reply) => {
      if (!farmAuthorized(request, reply)) return
      return snapshot({ scope: request.query.scope, estimates: false, checks: false })
    },
  )

  // HZ-246: farmd re-reads the served rules when it claims a task, so a save
  // made while the task sat in the queue still reaches it. null for a scope
  // means "use the rules file".
  fastify.get(
    '/api/farm/rules',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { project: { type: 'string', maxLength: 200 }, repo: { type: 'string', maxLength: 300 } },
        },
      },
    },
    (request, reply) => {
      if (!farmAuthorized(request, reply)) return
      const served = rulesStore.servedRulesFor(request.query.project, request.query.repo)
      return { project: served.project ?? null, repo: served.repo ?? null }
    },
  )

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
      // HZ-235: a merge into main may leave other items' PRs conflicted —
      // queue the auto-resolve scan (autoResolve.js). Only merges into main
      // on a connected repo; it never scans inline.
      if (pr.merged && pr.base?.ref === 'main' && store.listRepos().some((r) => r.repo === repoFullName)) {
        autoResolve.noteMainMoved(repoFullName, { prs: [pr.number], sha: pr.merge_commit_sha ?? null })
      }
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

    // e2e only (HZ-154), same reasoning: with no farm daemon, the scoped
    // conflict path has nothing to answer the /conflicts/resolve call the
    // Accept gate's "send back to resolve conflicts" button makes. This queues
    // one canned farmd reply so the spec can drive the real button, through
    // the real PIN, and assert what the human actually ends up looking at.
    fastify.post('/api/test/conflict-reply', async (request) => {
      orchestrator.setConflictReplyForTest(request.body?.reply ?? null)
      return { ok: true }
    })

    // e2e only (HZ-183), same reasoning: with no GitHub token, nothing can
    // tell the Accept gate's pre-merge check which commits to test-merge.
    // This sets GitHub's answer for one PR (see github.setPrStateForTest);
    // the farm.premerge run it triggers is the real one, under the e2e
    // server's own throwaway FARM_HOME (playwright.config.js).
    fastify.post('/api/test/github-pr', async (request) => {
      github.setPrStateForTest(request.body?.pr ?? null)
      return { ok: true }
    })
  }

  return fastify
}
