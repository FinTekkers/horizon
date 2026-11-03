// HZ-703: the member's own check commands are a member-only Admin section.
// The owner's list is exactly what it was before, and never offers it.

import { expect, test } from 'vitest'

import { adminPath, isMemberOnlySection, isOwnerOnlySection, parseAdminPath, visibleSections } from './adminRoutes'

test("the owner's sections are unchanged and leave out the member's check commands", () => {
  expect(visibleSections(true).map((s) => s.key)).toEqual(['projects', 'deploys', 'flaky', 'github', 'account'])
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
