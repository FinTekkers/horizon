// HZ-178: OpenAPI spec policy, kept out of app.js so that file only gains
// `response`/`security` blocks on its existing routes.
//
// The document itself is never authored and never checked in — @fastify/swagger
// builds it from the routes app.js registers, and GET /api/openapi.json serves
// whatever that produces. What lives here is the policy around that: which
// routes stay private, which security schemes exist, and the handful of
// response-schema shapes the routes reuse.
//
// THE ONE RULE EVERY SHAPE BELOW OBEYS: a Fastify response schema is also a
// serializer, and fast-json-stringify strips any property the schema does not
// describe. So every object shape here is `additionalProperties: true` with no
// `required` and no declared properties. That makes stripping structurally
// impossible rather than avoided route by route — the cost is a shallow
// reference (an endpoint documents "a JSON object", not its keys), which is a
// per-route follow-up rather than something that has to be got right here.

import { SESSION_COOKIE_NAME } from './config.js'

// Routes deliberately absent from the published spec. The success metric names
// four prefixes; the fifth entry is approve-via-whatsapp, which matches none of
// them but is an internal bridge leg all the same — it carries its own
// WA_APPROVAL_SECRET, is in app.js's SESSION_EXEMPT, and has no browser caller.
// Publishing it would advertise a credential-gated side door as public API.
//
// Both the `hide` transform below and openapi-route-coverage-derived.test.mjs
// read this one list, so a new /api/farm/* route is excluded with no edit here
// and the test can never disagree with the spec about what is internal.
//
// These match REGISTERED ROUTE urls (`/api/items/:id/gates/:stepIndex/...`),
// not request paths — app.js's SESSION_EXEMPT is the list that matches those,
// and its equivalent line can afford a stricter `\d+` where this one cannot.
export const INTERNAL_PREFIXES = [
  /^\/api\/farm\//,
  /^\/api\/test\//,
  /^\/api\/webhooks\//,
  /^\/api\/wa\//,
  /^\/api\/items\/[^/]+\/gates\/[^/]+\/approve-via-whatsapp$/,
]

export function isInternal(url) {
  const path = String(url).split('?')[0]
  return INTERNAL_PREFIXES.some((re) => re.test(path))
}

// A JSON object whose properties are deliberately undescribed — see the rule at
// the top of this file. Also why no success response in this API can leak a
// secret into the spec: there are no property names in it to leak.
export const OK_OBJECT = { type: 'object', additionalProperties: true }

// Documented 4xx/5xx bodies. `additionalProperties: true` is what carries
// Horizon's own error payloads through untouched — `{error}` plus occasional
// extras (`limit`, `matches`, `commit`, `detail`) — so none of those are listed.
//
// The four properties that ARE named are Fastify's, and they are named because
// additionalProperties alone is not enough for them. Fastify answers a schema
// validation failure (and a malformed JSON body) by sending an Error INSTANCE,
// whose statusCode/code/error/message are non-enumerable or inherited;
// fast-json-stringify copies additional properties by enumerating them, so
// without these four declared, a 400 that reads
// `{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request",
// "message":"body/title must NOT have more than 200 characters"}` today
// silently becomes `{}`. api-field-limits-derived.test.mjs is what caught that;
// openapi-no-behaviour-change.test.mjs pins it directly.
export const ERROR_OBJECT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    code: { type: 'string' },
    statusCode: { type: 'integer' },
  },
}

// A response with no body at all — the two /api/auth/google/* routes answer
// with reply.redirect(). `type: 'null'` is what keeps @fastify/swagger from
// inventing an application/json content block for a 302 that has none, and it
// leaves the empty payload exactly as empty as it is today (asserted in
// openapi-no-behaviour-change.test.mjs).
export function noContent(description) {
  return { type: 'null', description }
}

// Non-JSON success bodies (the standalone HTML pages, the shared stylesheet,
// the SSE stream). Fastify 5's `content` form documents the real media type and
// — verified, not assumed — hands the body through byte for byte rather than
// JSON-quoting it.
export function textResponse(mime, description) {
  return { content: { [mime]: { schema: { type: 'string', description } } } }
}

// The session cookie every non-exempt /api/* route needs. app.js injects this
// from one onRoute hook keyed on its own sessionExempt(), so the spec cannot
// drift from the gate that actually runs.
export const SESSION_SECURITY = [{ sessionCookie: [] }]

// The session cookie OR a personal API token (HZ-179) — two requirement objects
// mean "either one". This is what the onRoute hook injects on ordinary routes;
// SESSION_SECURITY stays for the routes a token may not call (token management
// and the auth routes), and the gate routes keep HUMAN_GATE_SECURITY.
export const API_SECURITY = [{ sessionCookie: [] }, { bearerToken: [] }]

// The session cookie AND the per-account human gate PIN. Declared inline on the
// routes that call humanAuthorized() — the PIN is a second, separate blocker
// (auth.verifyGatePin), so both schemes are required together rather than being
// alternatives.
export const HUMAN_GATE_SECURITY = [{ sessionCookie: [], humanGateKey: [] }]

// Fresh object per call: @fastify/swagger mutates the options it is handed
// (it defaults opts.mode in place), and buildApp() runs many times per test
// process.
export function swaggerOptions() {
  return {
    // Pinned, not left to the plugin's default, because the test that validates
    // the document picks its meta-schema by this version.
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Horizon API',
        version: '0.1.0',
        description:
          'Horizon drives work items through a fixed lifecycle of agent steps and human gates. ' +
          'This document is generated at server start from the routes themselves — it is never ' +
          'hand-edited. Routes under /api/farm, /api/test, /api/webhooks and /api/wa are internal ' +
          'and deliberately absent.',
      },
      components: {
        securitySchemes: {
          // Set by POST /api/auth/login or the Google SSO callback. Name comes
          // from config.js so the spec can't name a cookie the server doesn't
          // read; no value, default or example appears anywhere in this file.
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: SESSION_COOKIE_NAME,
            description: 'Session cookie issued at login. Required by every route except the auth and probe routes.',
          },
          // Personal API tokens (HZ-179), created in Admin. Accepted wherever
          // API_SECURITY is declared; never on gate or token-management routes.
          bearerToken: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Personal API token (hz_…), created in Admin and sent as `Authorization: Bearer <token>`. ' +
              'Acts with its user’s permissions. Cannot approve gates or create, list or revoke tokens.',
          },
          // The human gate (HZ-21): every account has its own auto-generated
          // PIN, kept separate from login so an agent that can read this
          // database still cannot approve its own gate.
          humanGateKey: {
            type: 'apiKey',
            in: 'header',
            name: 'x-human-key',
            description: 'Per-account human gate PIN. Required on gate approvals, rejections and the other human-only mutations.',
          },
        },
      },
    },
    // @fastify/swagger wants { schema, url } back, not a bare { hide: true } —
    // returning the latter publishes every internal route instead of hiding it.
    // Internal routes often have no schema at all, hence the `|| {}`.
    transform: ({ schema, url }) => (isInternal(url) ? { schema: { ...(schema || {}), hide: true }, url } : { schema, url }),
  }
}
