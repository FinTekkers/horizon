// HZ-549: the contract behind Admin's Productivity page.
//
// domain/productivity.schema.json is the 200 response of
// GET /api/admin/productivity — app.js hands it to Fastify as the route's
// response schema, so the one file is the serializer, the published OpenAPI
// entry and what the contract test validates the fixture against.
//
// Until HZ-550 lands the route only serves domain/fixtures/productivity.json
// (the design's figures, every cost null). HZ-550 replaces the body of
// productivityReport() with real aggregation; the schema and route stay.

import { readFileSync } from 'node:fs'

const readDomainJson = (rel) => JSON.parse(readFileSync(new URL(`../../domain/${rel}`, import.meta.url), 'utf8'))

export const PRODUCTIVITY_RESPONSE_SCHEMA = readDomainJson('productivity.schema.json')
const FIXTURE = readDomainJson('fixtures/productivity.json')

export const PRODUCTIVITY_RANGES = ['7d', '14d', '30d']

export const PRODUCTIVITY_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { type: 'string', enum: PRODUCTIVITY_RANGES, default: '14d' },
    // Any project id is echoed, not looked up: real ids from /api/projects must
    // not 404 against the fixture's.
    project: { type: 'string', minLength: 1, maxLength: 64, default: 'all' },
  },
}

// The report for one range and project. Read-only: no DB, no writes.
export function productivityReport({ range, project }) {
  return { ...FIXTURE, range, project }
}
