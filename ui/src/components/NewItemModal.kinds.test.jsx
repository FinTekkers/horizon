// HZ-382 guardrail 3: the kind cards render from domain/js/lifecycle.js's
// ITEM_KIND_INFO, not a list typed into the modal. A mocked extra kind must
// show up as an extra card. Its own file because vi.mock is file-wide.
// HZ-446: Plan is the third real kind, so the mocked one is the fourth.

import { expect, test, afterEach, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({ createItem: vi.fn(async () => ({ ok: true, id: 'HZ-1' })) }))
vi.mock('../../../domain/js/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ITEM_KIND_INFO: [...actual.ITEM_KIND_INFO, { kind: 'chore', label: 'Chore', description: 'An extra kind, for this test only.' }],
  }
})

import NewItemModal from './NewItemModal'

afterEach(cleanup)

test('one radio card per ITEM_KIND_INFO entry — an extra kind shows an extra card', () => {
  const { getByRole } = render(<NewItemModal projects={[]} onClose={() => {}} onCreated={() => {}} />)
  const group = getByRole('radiogroup', { name: 'Kind' })
  expect(within(group).getAllByRole('radio')).toHaveLength(4)
  expect(within(group).getByRole('radio', { name: /Chore/ }).checked).toBe(false)
})
