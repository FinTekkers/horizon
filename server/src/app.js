// Route/wiring layer, separated from the listen/boot entry (server.js) so
// tests can build the app and drive it with fastify.inject().

import Fastify from 'fastify'
import * as store from './store.js'
import * as github from './github.js'
import * as orchestrator from './orchestrator.js'
import { WEBHOOK_SECRET, FARM_SHARED_SECRET, UI_URL } from './config.js'
import { marked } from 'marked'
import { db } from './db.js'
import { getActiveProjectId, getRepoUrl, setSetting, getToken, humanKeyConfigured, setHumanKey, verifyHumanKey } from './settings.js'
import { STEPS } from './lifecycle.js'
import { PERSONAS } from './personas.js'
import * as definitions from './definitions.js'

// ---- SSE ----

const sseClients = new Set()

function snapshot() {
  return {
    repoUrl: getRepoUrl(),
    projects: store.listProjects(),
    activeProjectId: getActiveProjectId(),
    farm: orchestrator.getFarmState(),
    sync: github.getSyncState(),
    security: { gateKeyConfigured: humanKeyConfigured() },
    items: store.listItems(), // scoped to the active project
  }
}

// Human gates are human-only: once a gate key is set, gate-mutating routes
// demand it. The plaintext lives only in the human's browser — agents (and
// anything else on this machine) can at best read the hash.
function humanAuthorized(request, reply) {
  if (verifyHumanKey(request.headers['x-human-key'] || '')) return true
  reply.code(401).send({ error: 'human_gate_key_required' })
  return false
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

  // Full-page, formatted view of a step's artifact ("View full artifact"
  // opens this in a new tab — the inline viewport is too cramped for plans).
  fastify.get(
    '/api/items/:id/artifacts/:stepIndex',
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
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const title = `${esc(id)} · ${esc(step?.label || `step ${stepIndex}`)}`
      const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; background: #F3F1F8; color: #38294F; font: 16px/1.65 -apple-system, 'DM Sans', 'Segoe UI', sans-serif; }
  .page { max-width: 860px; margin: 0 auto; padding: 40px 28px 80px; }
  .meta { font-size: 13px; color: #8C8C8E; margin-bottom: 18px; }
  .meta a { color: #2E6CB2; text-decoration: none; }
  article { background: #fff; border-radius: 18px; box-shadow: 0 18px 40px rgba(56,41,79,.08); padding: 36px 42px; }
  h1, h2, h3 { line-height: 1.25; } h2 { margin-top: 2em; border-bottom: 1px solid #ECE7F3; padding-bottom: 6px; }
  code { background: #F0ECF6; border-radius: 5px; padding: 1px 6px; font: 13.5px/1.5 'DM Mono', ui-monospace, monospace; }
  pre { background: #2A2A2E; color: #F3F1F8; border-radius: 12px; padding: 16px 18px; overflow-x: auto; }
  pre code { background: none; color: inherit; padding: 0; }
  blockquote { margin: 0; padding: 2px 16px; border-left: 4px solid #C9B4D9; color: #5A5568; background: #FAF8FC; border-radius: 0 8px 8px 0; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ECE7F3; padding: 6px 12px; }
</style></head><body><div class="page">
<div class="meta"><a href="${UI_URL}/${esc(id.toLowerCase())}">← ${esc(id)} in Horizon</a> · ${title} · attempt ${run.attempt} · ${esc(run.ended_at)} UTC</div>
<article>${marked.parse(run.artifact)}</article>
</div></body></html>`
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
          return reply.code(502).send({ error: `merge failed: ${err.message}` })
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
          return reply.code(502).send({ error: `issue close failed: ${err.message}` })
        }
      }
      const result = store.approveGate(id, stepIndex, notes)
      // Approval notes are decisions — mirror them onto the issue thread.
      if (!result.error && notes && item?.repo && item.issue != null) {
        github
          .postIssueComment(item, `### ✅ Gate approved — ${STEPS[stepIndex].label}\n\n> ${notes}\n\n_Human reviewer · [open in Horizon](${UI_URL}/${id.toLowerCase()}) · posted by Horizon_`)
          .catch(() => {})
      }
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
          properties: { target: { type: 'string' }, feedback: { type: 'string' } },
        },
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      return send(reply, store.requestChanges(request.params.id, request.body?.target, request.body?.feedback))
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
      return send(reply, store.restartPhase(request.params.id, request.params.phase, request.body?.reason))
    },
  )

  // Set/rotate the human gate key (rotating requires the current one).
  fastify.post(
    '/api/security/key',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string', minLength: 4, maxLength: 200 },
            currentKey: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    (request, reply) => {
      if (humanKeyConfigured() && !verifyHumanKey(request.body.currentKey || '')) {
        return reply.code(401).send({ error: 'current gate key required to change it' })
      }
      setHumanKey(request.body.key.trim())
      broadcast()
      return { ok: true }
    },
  )

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

  // Edits are human-gated (same key as approvals) and become git commits with
  // the actor in the message — git history is the audit trail. Global kinds
  // (role/persona) affect every project; the UI labels them as such.
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
            actor: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    (request, reply) => {
      if (!humanAuthorized(request, reply)) return
      const { kind, name } = request.params
      const actor = (request.body.actor || 'human via UI').trim()
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
    return reply.code(204).send()
  })

  return fastify
}
