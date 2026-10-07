// HZ-317: narrowing a project to some of its repos. The pure rules behind the
// repo chips — filtering, the button label and the stale-value fallbacks.

import { expect, test, afterEach } from 'vitest'

import {
  ALL_PROJECTS,
  filterByProject,
  projectFilterLabel,
  readStoredRepoFilters,
  repoChipLabel,
  storedReposFor,
  validRepoFilter,
  writeRepoFilters,
} from './projectFilter'

afterEach(() => {
  localStorage.removeItem('horizon.projectRepos')
})

const FIN = {
  id: 7,
  name: 'Fintekkers',
  enabled: true,
  repos: [
    { repo: 'FinTekkers/ledger-service', prefix: 'LS' },
    { repo: 'FinTekkers/ledger-models', prefix: 'LM' },
    { repo: 'FinTekkers/ledger-client', prefix: 'LC' },
    { repo: 'FinTekkers/ui-service', prefix: 'UI' },
    { repo: 'FinTekkers/horizon', prefix: 'HZ' },
  ],
}
const [LS, LM, LC, UI, HZ] = FIN.repos.map((r) => r.repo)

const ITEMS = [
  { id: 'LS-1', project_id: 7, repo: LS },
  { id: 'LM-1', project_id: 7, repo: LM },
  { id: 'HZ-1', project_id: 7, repo: HZ },
  { id: 'LOCAL-1', project_id: 7, repo: null },
  { id: 'OT-1', project_id: 8, repo: 'Other/repo' },
]
const ids = (items) => items.map((it) => it.id)

test('filterByProject with repos keeps only items whose repo is selected', () => {
  expect(ids(filterByProject(ITEMS, 7, [LS, HZ]))).toEqual(['LS-1', 'HZ-1'])
})

test('filterByProject with repos = null matches today: every item in the project, repo or not', () => {
  expect(ids(filterByProject(ITEMS, 7, null))).toEqual(['LS-1', 'LM-1', 'HZ-1', 'LOCAL-1'])
  expect(filterByProject(ITEMS, 7, null)).toEqual(filterByProject(ITEMS, 7))
  expect(filterByProject(ITEMS, ALL_PROJECTS, null)).toBe(ITEMS)
})

test('an item with no repo is hidden once the project is narrowed', () => {
  expect(ids(filterByProject(ITEMS, 7, [LS, LM, LC, UI]))).not.toContain('LOCAL-1')
})

test('the label is the plain name for all repos, prefixes for 1–3, and N of M from 4', () => {
  expect(projectFilterLabel(null, null)).toBe('All projects')
  expect(projectFilterLabel(FIN, null)).toBe('Fintekkers')
  expect(projectFilterLabel(FIN, [LS])).toBe('Fintekkers · LS')
  expect(projectFilterLabel(FIN, [LS, LM])).toBe('Fintekkers · LS, LM')
  expect(projectFilterLabel(FIN, [LS, LM, LC])).toBe('Fintekkers · LS, LM, LC')
  expect(projectFilterLabel(FIN, [LS, LM, LC, UI])).toBe('Fintekkers · 4 of 5 repos')
})

test('a chip reads <PREFIX> · <repo name>, or just the name with no prefix', () => {
  expect(repoChipLabel(FIN.repos[0])).toBe('LS · ledger-service')
  expect(repoChipLabel({ repo: 'Org/plain', prefix: '' })).toBe('plain')
})

test('validRepoFilter keeps a valid subset, in the project’s repo order and de-duplicated', () => {
  expect(validRepoFilter([HZ, LS, LS], FIN)).toEqual([LS, HZ])
})

test('validRepoFilter falls back to all repos (null) for anything stale or meaningless', () => {
  expect(validRepoFilter([LS, 'FinTekkers/disconnected'], FIN)).toBeNull()
  expect(validRepoFilter([], FIN)).toBeNull()
  expect(validRepoFilter([LS, LM, LC, UI, HZ], FIN)).toBeNull()
  expect(validRepoFilter('FinTekkers/ledger-service', FIN)).toBeNull()
  expect(validRepoFilter({ 0: LS }, FIN)).toBeNull()
  expect(validRepoFilter(undefined, FIN)).toBeNull()
  expect(validRepoFilter([LS], null)).toBeNull()
  expect(validRepoFilter([LS], { ...FIN, repos: [FIN.repos[0]] })).toBeNull()
})

test('stored repo choices survive a round trip; bad JSON or a non-object reads as none', () => {
  writeRepoFilters({ 7: [LS, LM] })
  expect(readStoredRepoFilters()).toEqual({ 7: [LS, LM] })
  for (const raw of ['{not json', '[]', 'null', '"x"', '3']) {
    localStorage.setItem('horizon.projectRepos', raw)
    expect(readStoredRepoFilters(), raw).toEqual({})
  }
  localStorage.setItem('horizon.projectRepos', '{"7":"x"}')
  expect(validRepoFilter(storedReposFor(readStoredRepoFilters(), 7), FIN)).toBeNull()
})

test('storedReposFor reads only own entries, never inherited keys', () => {
  expect(storedReposFor({}, 'toString')).toBeUndefined()
  expect(storedReposFor({ 7: [LS] }, 7)).toEqual([LS])
})
