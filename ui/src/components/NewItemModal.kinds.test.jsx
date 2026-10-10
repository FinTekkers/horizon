// HZ-382 guardrail 3: the kind cards render from domain/js/lifecycle.js's
// ITEM_KIND_INFO, not a list typed into the modal. A mocked third kind must
// show up as a third card. Its own file because vi.mock is file-wide.

import { expect, test, afterEach, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({ createItem: vi.fn(async () => ({ ok: true, id: 'HZ-1' })) }))
vi.mock('../../../domain/js/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ITEM_KIND_INFO: [...actual.ITEM_KIND_INFO, { kind: 'chore', label: 'Chore', description: 'A third kind, for this test only.' }],
  }
})

import NewItemModal from './NewItemModal'

afterEach(cleanup)

test('one radio card per ITEM_KIND_INFO entry — a third kind shows a third card', () => {
  const { getByRole } = render(<NewItemModal projects={[]} onClose={() => {}} onCreated={() => {}} />)
  const group = getByRole('radiogroup', { name: 'Kind' })
  expect(within(group).getAllByRole('radio')).toHaveLength(3)
  expect(within(group).getByRole('radio', { name: /Chore/ }).checked).toBe(false)
})
