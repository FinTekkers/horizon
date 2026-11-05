// HZ-703: the member's own check commands are a member-only Admin section.
// The owner's list is exactly what it was before, and never offers it.

import { expect, test } from 'vitest'

import { ADMIN_HOME, adminPath, isMemberOnlySection, isOwnerOnlySection, parseAdminPath, visibleSections } from './adminRoutes'

test("the owner's sections lead with Needs attention and leave out the member's check commands", () => {
  expect(visibleSections(true).map((s) => s.key)).toEqual(['attention', 'projects', 'deploys', 'flaky', 'github', 'account'])
  expect(isMemberOnlySection('checks')).toBe(true)
  expect(isMemberOnlySection('projects')).toBe(false)
  expect(isMemberOnlySection('toString')).toBe(false)
})

test('a member gets their check commands and Account, and no owner-only section', () => {
  expect(visibleSections(false).map((s) => s.key)).toEqual(['checks', 'account'])
  expect(isOwnerOnlySection('checks')).toBe(false)
  expect(isOwnerOnlySection('deploys')).toBe(true)
  expect(parseAdminPath('checks')).toMatchObject({ section: 'checks', unknown: false })
  expect(adminPath({ section: 'checks' })).toBe('/admin/checks')
})

// ---- HZ-764: project pages, repository pages and Needs attention ----

test('bare /admin is home with no section; a member is sent to Account from it', () => {
  expect(parseAdminPath('')).toEqual(ADMIN_HOME)
  expect(ADMIN_HOME).toMatchObject({ section: null, home: true, unknown: false })
  expect(isOwnerOnlySection(null)).toBe(true)
  expect(isOwnerOnlySection('attention')).toBe(true)
})

test.each([
  ['attention', { section: 'attention', project: null, tab: null, repo: null, home: false, unknown: false }],
  ['projects', { section: 'projects', project: null, tab: null, repo: null, unknown: false }],
  ['projects/new', { section: 'projects', project: 'new', tab: null, repo: null, unknown: false }],
  ['projects/12', { section: 'projects', project: '12', tab: null, repo: null, unknown: false }],
  ['projects/12/automation', { section: 'projects', project: '12', tab: 'automation', repo: null, unknown: false }],
  ['projects/12/Agents', { section: 'projects', project: '12', tab: 'agents', repo: null, unknown: false }],
  ['projects/12/settings', { section: 'projects', project: '12', tab: 'settings', repo: null, unknown: false }],
  ['projects/12/repos/acme/web', { section: 'projects', project: '12', tab: 'repositories', repo: 'acme/web', unknown: false }],
])('%s parses to its page', (rest, route) => {
  expect(parseAdminPath(rest)).toMatchObject(route)
})

// The ruling on the pre-HZ-764 placeholder shape: unknown, so App rewrites it
// to /admin. A slug is not a project id, and a repo is not a tab.
test.each([
  'projects/fintekkers/ui-service/checks',
  'projects/1/ui-service/checks',
  'projects/1/acme',
  'projects/1/bogus',
  'projects/1/repos/acme',
  'projects/1/repos/acme/web/checks',
  'projects/new/automation',
  'projects/fintekkers',
  'attention/more',
])('%s is unknown', (rest) => {
  expect(parseAdminPath(rest)).toMatchObject({ unknown: true, home: false })
})

test('adminPath builds each page, the Repositories tab being the bare project path', () => {
  expect(adminPath({ section: 'attention' })).toBe('/admin/attention')
  expect(adminPath({ section: 'projects', project: 12 })).toBe('/admin/projects/12')
  expect(adminPath({ section: 'projects', project: 12, tab: 'repositories' })).toBe('/admin/projects/12')
  expect(adminPath({ section: 'projects', project: 12, tab: 'agents' })).toBe('/admin/projects/12/agents')
  expect(adminPath({ section: 'projects', project: 12, repo: 'acme/web' })).toBe('/admin/projects/12/repos/acme/web')
  expect(adminPath({ section: 'projects', project: 'new' })).toBe('/admin/projects/new')
  expect(adminPath({ section: 'toString' })).toBe('/admin')
  for (const path of ['/admin/projects/12/agents', '/admin/projects/12/repos/acme/web', '/admin/attention']) {
    const route = parseAdminPath(path.slice('/admin/'.length))
    expect(adminPath(route)).toBe(path)
  }
})
