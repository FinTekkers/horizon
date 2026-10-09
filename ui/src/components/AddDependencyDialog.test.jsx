// HZ-365: the rule-block banner's Add dependency picker. It lists items the
// blocked one could wait on and hands the pick to onAdd; HZ-346's route does
// the rest.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'

import AddDependencyDialog from './AddDependencyDialog'
import { IMPLEMENT_STEP_INDEX, STEPS } from '../../../domain/js/lifecycle.js'

afterEach(cleanup)

const ITEM = { id: 'LS-17', title: 'Settle trades', cursor: IMPLEMENT_STEP_INDEX, blockedBy: [{ id: 'LM-40', title: 'Old blocker' }] }
const ITEMS = [
  ITEM,
  { id: 'LM-40', title: 'Old blocker', cursor: 2 },
  { id: 'LM-42', title: 'Settlement field', cursor: 2 },
  { id: 'LM-41', title: 'Shipped', cursor: STEPS.length },
  { id: 'LM-39', title: 'Dropped', cursor: 2, abandoned_at: '2026-10-01 00:00:00' },
]

const select = () => document.querySelector('#add-dependency-item')

test('lists open and closed items, never the item itself, a current blocker or an abandoned item; Add posts the pick', async () => {
  const onAdd = vi.fn(async () => ({ ok: true }))
  const onClose = vi.fn()
  const { getByRole } = render(<AddDependencyDialog item={ITEM} items={ITEMS} onAdd={onAdd} onFileNew={vi.fn()} onClose={onClose} />)
  expect([...select().options].map((o) => o.value)).toEqual(['', 'LM-42', 'LM-41'])

  fireEvent.change(select(), { target: { value: 'LM-42' } })
  fireEvent.click(getByRole('button', { name: 'Add dependency' }))
  expect(onAdd).toHaveBeenCalledWith('LS-17', 'LM-42')
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

test('a refused link shows the reason and keeps the dialog open', async () => {
  const onAdd = vi.fn(async () => {
    throw new Error('dependency_cycle')
  })
  const onClose = vi.fn()
  const { getByRole, findByRole } = render(<AddDependencyDialog item={ITEM} items={ITEMS} onAdd={onAdd} onFileNew={vi.fn()} onClose={onClose} />)
  fireEvent.change(select(), { target: { value: 'LM-42' } })
  fireEvent.click(getByRole('button', { name: 'Add dependency' }))
  expect((await findByRole('alert')).textContent).toBe("Couldn't add: dependency_cycle")
  expect(onClose).not.toHaveBeenCalled()
})

test('File a new upstream item fires onFileNew', () => {
  const onFileNew = vi.fn()
  const { getByRole } = render(<AddDependencyDialog item={ITEM} items={ITEMS} onAdd={vi.fn()} onFileNew={onFileNew} onClose={vi.fn()} />)
  fireEvent.click(getByRole('button', { name: 'File a new upstream item' }))
  expect(onFileNew).toHaveBeenCalled()
})
