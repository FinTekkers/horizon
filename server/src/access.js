// Per-route access scopes and the guard that enforces them (HZ-655).
//
// Every route in app.js declares `config: { scope }`. The registry below is fed
// by app.js's onRoute hook and throws, naming the route, when a scope is
// missing, unknown, or of the wrong class for the route's URL — so a route
// without a scope stops buildApp(), and with it the server's boot.
//
// Two classes of scope, split by app.js's SESSION_EXEMPT list:
//   - EXEMPT_SCOPES label the session-exempt routes by the credential they
//     check themselves: `farm` (FARM_SHARED_SECRET), `hmac` (GitHub and Stripe
//     signatures), `wa` (WA_APPROVAL_SECRET), `public` (none, or their own
//     session check). The guard never touches them.
//   - USER_SCOPES label the session-gated routes. The guard runs after the
//     onRequest login gate, so request.user is set.
//
// The owner — user.role 'owner', never the email allowlist — passes every user
// scope, so the owner sees no change. For anyone else:
//   - owner, test        404
//   - self               passes; the handler acts on request.user only
//   - filtered           passes with request.viewer = { projectIds }; the
//                        handler must filter by it (store.listItems' viewer)
//   - member:item/run/project/slug/repo
//                        resolves the request to one project and passes only
//                        if the user is a member of it; else 404
//   - member:items       (HZ-658) the dependency routes: both params.id and
//                        body.dependsOnId must resolve to projects the user is
//                        a member of; else 404
//   - member:rule        (HZ-660) the /api/rules/:scope/:key routes: a
//                        `project` or `repo` key resolves to its project; any
//                        other scope (role, persona, global…) resolves to
//                        nothing, so a member can never edit global rules
//   - member:effective   (HZ-660) the effective-prompt preview: ?project=
//                        (by name) and ?repo= must resolve to one project; with
//                        neither, nothing — no global-only preview
// A guessed or unknown id gets the same 404 as a project the user may not see,
// never 403, so the answer cannot reveal that a project exists. Anything the
// guard cannot resolve — a missing scope, an unknown scope, a throw — is 404.

import { db } from './db.js'
import { hasNoProject } from './membership.js'
import { resolveProjectSlug } from './projectDefinitions.js'
import { rulesKey } from './definitions.js'

// `test` is the e2e-only /api/test/* routes (HORIZON_TEST_HOOKS=1). They sit
// behind the session gate, so it is a user scope, owner-only.
export const USER_SCOPES = Object.freeze([
  'owner',
  'self',
  'filtered',
  'test',
  'member:item',
  'member:items',
  'member:run',
  'member:project',
  'member:slug',
  'member:repo',
  'member:rule',
  'member:effective',
])
export const EXEMPT_SCOPES = Object.freeze(['farm', 'hmac', 'wa', 'public'])

const NOT_FOUND = { error: 'not_found' }

const selectRole = db.prepare('SELECT role FROM user WHERE id = ?')
const selectMemberProjects = db.prepare('SELECT project_id FROM project_member WHERE user_id = ?')
const selectItemProject = db.prepare('SELECT project_id FROM work_item WHERE id = ?')
const selectRunProject = db.prepare('SELECT w.project_id FROM step_run s JOIN work_item w ON w.id = s.item_id WHERE s.id = ?')
const selectProject = db.prepare('SELECT id FROM project WHERE id = ?')
const selectRepoProject = db.prepare('SELECT project_id FROM project_repo WHERE repo = ?')
const selectRepoRows = db.prepare('SELECT repo, project_id FROM project_repo')

export function isOwner(userId) {
  return typeof userId === 'string' && selectRole.get(userId)?.role === 'owner'
}

// HZ-656: the live feed re-reads this on every flush, so a membership change
// reaches a connected tab on its next frame. Any route that writes
// project_member must call store.notifyChange(), or the tab waits for an
// unrelated change.
export function memberProjectIds(userId) {
  return new Set(selectMemberProjects.all(userId).map((row) => row.project_id))
}

// The own string property `key` of a params/query/body object, else null.
function ownString(source, key) {
  if (source == null || typeof source !== 'object' || !Object.hasOwn(source, key)) return null
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : null
}

// The project of the connected repo whose rules key is `key` (owner__name),
// matched forward through rulesKey rather than by reversing `__`, which is
// lossy. Null when no repo — or repos in two projects — share the key. A full
// scan per rule request; fine at today's handful of repos.
function repoKeyProject(key) {
  if (key == null) return null
  const ids = new Set(selectRepoRows.all().filter((row) => rulesKey('repo', row.repo) === key).map((row) => row.project_id))
  return ids.size === 1 ? [...ids][0] : null
}

// The project a member:* scope points this request at, or null when the id is
// missing, unknown, or names an item with no real project (NULL or
// `Unlinked items`, which only the owner sees).
export function projectForScope(scope, request) {
  let projectId = null
  switch (scope) {
    case 'member:item': {
      const id = ownString(request.params, 'id')
      projectId = id == null ? null : (selectItemProject.get(id)?.project_id ?? null)
      break
    }
    case 'member:run': {
      const runId = ownString(request.params, 'runId')
      projectId = runId == null || !/^\d+$/.test(runId) ? null : (selectRunProject.get(Number(runId))?.project_id ?? null)
      break
    }
    case 'member:project': {
      const id = ownString(request.params, 'id')
      projectId = id == null || !/^\d+$/.test(id) ? null : (selectProject.get(Number(id))?.id ?? null)
      break
    }
    case 'member:slug': {
      projectId = resolveProjectSlug(ownString(request.params, 'slug'))?.id ?? null
      break
    }
    case 'member:repo': {
      // HZ-658: a request with a body resolves from the body alone — the
      // handler reads body.repo, so a query repo must never stand in for it.
      const hasBody = request.body != null && typeof request.body === 'object'
      const repo = hasBody ? ownString(request.body, 'repo') : ownString(request.query, 'repo')
      projectId = repo == null ? null : (selectRepoProject.get(repo)?.project_id ?? null)
      // HZ-658: a body projectId naming another project resolves to nothing,
      // so a non-member cannot probe it through the handler's 400. Compared as
      // the integer the body schema makes it, never through ownString.
      const named = request.body != null && typeof request.body === 'object' && Object.hasOwn(request.body, 'projectId') ? request.body.projectId : null
      if (named != null && named !== projectId) projectId = null
      break
    }
    case 'member:rule': {
      const ruleScope = ownString(request.params, 'scope')
      const key = ownString(request.params, 'key')
      if (ruleScope === 'project') projectId = resolveProjectSlug(key)?.id ?? null
      else if (ruleScope === 'repo') projectId = repoKeyProject(key)
      break
    }
    case 'member:effective': {
      const name = ownString(request.query, 'project')
      const repo = ownString(request.query, 'repo')
      const fromProject = name == null ? null : (resolveProjectSlug(rulesKey('project', name))?.id ?? null)
      const fromRepo = repo == null ? null : repoKeyProject(rulesKey('repo', repo))
      if (name != null && fromProject == null) break
      if (repo != null && fromRepo == null) break
      if (fromProject != null && fromRepo != null && fromProject !== fromRepo) break
      projectId = fromProject ?? fromRepo
      break
    }
    default:
      return null
  }
  return projectId == null || hasNoProject(db, projectId) ? null : projectId
}

// The projects a member:* scope points this request at — every one must be the
// user's. member:items (HZ-658) is the item and the item it depends on; any
// other scope is its one project. Only createGuard (and its tests) call this.
export function projectsForScope(scope, request, resolve = projectForScope) {
  if (scope === 'member:items') {
    return [resolve('member:item', request), resolve('member:item', { params: { id: ownString(request.body, 'dependsOnId') } })]
  }
  return [resolve(scope, request)]
}

// What a `filtered` handler filters by: null for the owner (unfiltered), else
// { projectIds } — the projects the user is a member of.
export function viewerFor(request) {
  return viewerForUser(request.user?.id)
}

// HZ-656: viewerFor for a user id, so the live feed can re-read a connected
// tab's viewer on every flush. Fails closed: a throw, or a missing user id, is
// an empty viewer — nothing — never the owner's null. `memberProjects` is
// buildApp's test seam, as in createGuard.
export function viewerForUser(userId, memberProjects = memberProjectIds) {
  try {
    if (isOwner(userId)) return null
    return { projectIds: typeof userId === 'string' ? memberProjects(userId) : new Set() }
  } catch {
    return { projectIds: new Set() }
  }
}

// The preHandler. `resolveProject` and `memberProjects` are seams for tests
// (app.js's buildApp passes them through); production uses projectForScope
// and memberProjectIds.
export function createGuard({ resolveProject = projectForScope, memberProjects = memberProjectIds } = {}) {
  return async function guard(request, reply) {
    // An unmatched URL keeps Fastify's own 404.
    if (request.is404) return
    try {
      const scope = request.routeOptions?.config?.scope
      if (EXEMPT_SCOPES.includes(scope)) return
      const userId = request.user?.id
      if (typeof userId !== 'string' || !USER_SCOPES.includes(scope)) return reply.code(404).send(NOT_FOUND)
      if (isOwner(userId)) return
      if (scope === 'self') return
      if (scope === 'filtered') {
        request.viewer = { projectIds: memberProjects(userId) }
        return
      }
      if (!scope.startsWith('member:')) return reply.code(404).send(NOT_FOUND)
      const projectIds = projectsForScope(scope, request, resolveProject)
      const memberOf = memberProjects(userId)
      if (projectIds.some((projectId) => projectId == null || !memberOf.has(projectId))) return reply.code(404).send(NOT_FOUND)
    } catch (err) {
      request.log.warn({ err }, 'access guard failed closed')
      return reply.code(404).send(NOT_FOUND)
    }
  }
}

export const guard = createGuard()

// The route-scope registry. record() is called from app.js's onRoute hook for
// every route, Fastify's automatic HEAD routes included; list() is what
// app.routeScopes() returns. `isExempt(url)` is app.js's sessionExempt.
export function createScopeRegistry({ isExempt }) {
  const routes = []
  return {
    record(routeOptions) {
      const methods = [routeOptions.method].flat()
      const name = `${methods.join(',')} ${routeOptions.url}`
      const scope = routeOptions.config?.scope
      if (scope === undefined) throw new Error(`route scope missing: ${name}`)
      const exemptScope = EXEMPT_SCOPES.includes(scope)
      if (!exemptScope && !USER_SCOPES.includes(scope)) throw new Error(`route scope invalid: '${scope}' on ${name}`)
      // Each :param filled with a digit, so a pattern like gates/\d+ matches.
      if (exemptScope !== isExempt(routeOptions.url.replace(/:[^/]+/g, '0'))) {
        throw new Error(`route scope mismatch: ${scope} on ${name}`)
      }
      for (const method of methods) routes.push({ method, url: routeOptions.url, scope })
    },
    list() {
      return routes.map((route) => ({ ...route }))
    },
  }
}
