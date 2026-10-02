// HZ-135 success metric 2, the UI leg: "the UI picker ... derives from it."
//
// Before this change the intake modal had no test file at all, and the whole e2e
// suite contained exactly one priority reference — a fixture value in
// 09-queued-work.spec.js, which never rendered the picker. So "the picker derives
// from the vocabulary" was verifiable only by grepping for an import path, which
// is not a behavioural gate: an import can be present while the rendered control
// shows a stale hand-typed list beside it.
//
// This renders the real component and reads the real DOM. Every expectation comes
// from domain/js/priorities.js, so a value added to domain/priorities.json shows
// up in the picker or this fails — and nothing here hand-types a priority, which
// is why the file is not a hit for domain-priority-literals.test.mjs.
//
// ORDER is asserted as a sequence, not a set. The order is the visible half of
// this item: the segmented control renders the array left to right, severity
// first, and a reversed vocabulary would put Low where a human expects Critical.
//
// This is the UNIT level, and it resolves the import through Vite's dev
// resolution rather than the bundle a deploy ships. The browser-level half is
// e2e/tests/02-create-item.spec.js, which drives the same control against
// `vite build`'s output and reads the chosen value back off the board card.
// Neither one subsumes the other: this file covers every value and the default,
// the e2e spec covers one value through the real inlined JSON.

import { expect, test, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { PRIORITIES, DEFAULT_PRIORITY } from '../../../domain/js/priorities.js'
import NewItemModal from './NewItemModal'

vi.mock('../api', () => ({ createItem: vi.fn(async () => ({ ok: true, id: 'HZ-1' })) }))

afterEach(cleanup)

const noop = () => {}

// TWO repos on purpose. The modal renders a repository picker when a project
// carries more than one, and that picker reuses the same `.prio-seg__btn` class
// as the priority control — so an unscoped selector would pass here only by the
// accident of a single-repo fixture, and would silently start counting repository
// buttons as priorities for any real multi-repo project.
const PROJECT = { id: 1, name: 'FinTekkers', enabled: true, repos: [{ repo: 'FinTekkers/horizon' }, { repo: 'FinTekkers/ui-service' }] }

function renderModal() {
  return render(<NewItemModal projects={[PROJECT]} onClose={noop} onCreated={noop} />)
}

// The PRIORITY segmented control's buttons, in DOM order — scoped by the visible
// field label, which is what a human uses to tell the two controls apart.
function priorityButtons(container) {
  const field = [...container.querySelectorAll('.field')].find(
    (f) => f.querySelector('.field__label')?.textContent === 'Priority',
  )
  if (!field) throw new Error('the modal no longer renders a field labelled "Priority"')
  return [...field.querySelectorAll('.prio-seg__btn')]
}

test('the fixture really does render a second segmented control, so the scoping is load-bearing', () => {
  // Without this, priorityButtons() could go back to an unscoped query and every
  // assertion below would still pass.
  const { container } = renderModal()
  const unscoped = container.querySelectorAll('.prio-seg__btn').length
  expect(unscoped).toBe(priorityButtons(container).length + PROJECT.repos.length)
})

test('the picker offers exactly the declared vocabulary, IN ORDER', () => {
  const { container } = renderModal()
  const buttons = priorityButtons(container)
  expect(buttons.map((b) => b.textContent)).toEqual([...PRIORITIES])
})

test('the picker offers one option per declared value and no more', () => {
  // The count assertion is separate on purpose: a shortened domain/priorities.json
  // must shorten the picker, which is what "derives from it" means.
  const { container } = renderModal()
  expect(priorityButtons(container)).toHaveLength(PRIORITIES.length)
  expect(PRIORITIES.length).toBeGreaterThanOrEqual(3)
})

test('the initially selected option is the declared default', () => {
  const { container } = renderModal()
  const on = priorityButtons(container).filter((b) => b.className.includes('prio-seg__btn--on'))
  expect(on).toHaveLength(1)
  expect(on[0].textContent).toBe(DEFAULT_PRIORITY)
})

test('selecting a value moves the selection to exactly that option', () => {
  const { container } = renderModal()
  for (const value of PRIORITIES) {
    const button = priorityButtons(container).find((b) => b.textContent === value)
    fireEvent.click(button)
    const on = priorityButtons(container).filter((b) => b.className.includes('prio-seg__btn--on'))
    expect(on.map((b) => b.textContent)).toEqual([value])
  }
})

test('the picker does not render a value the vocabulary no longer declares', () => {
  // The other direction of the same claim: nothing extra is hard-coded alongside
  // the derived list.
  const { container } = renderModal()
  const rendered = priorityButtons(container).map((b) => b.textContent)
  for (const stale of ['Urgent', 'Blocker', 'None', 'Trivial']) {
    expect(rendered).not.toContain(stale)
  }
})

test('the submitted payload carries the selected priority', async () => {
  const { createItem } = await import('../api')
  const { container, getByText } = renderModal()

  // Fill the three required fields so validate() passes and the payload is built.
  fireEvent.change(container.querySelector('input'), { target: { value: 'An intake fixture' } })
  const textareas = [...container.querySelectorAll('textarea')]
  fireEvent.change(textareas[0], { target: { value: 'A clear outcome for the farm to plan against.' } })
  fireEvent.change(textareas[1], { target: { value: 'A measurable success criterion.' } })

  const chosen = PRIORITIES.at(-1)
  fireEvent.click(priorityButtons(container).find((b) => b.textContent === chosen))
  fireEvent.click(getByText('Create work item'))

  await vi.waitFor(() => expect(createItem).toHaveBeenCalled())
  expect(createItem.mock.calls.at(-1)[0].priority).toBe(chosen)
})

// ---- HZ-208: file into any enabled project ----

test('the project picker lists the given (enabled) projects, and picking one files with its repo', async () => {
  const { createItem } = await import('../api')
  const alpha = { id: 1, name: 'Alpha', enabled: true, repos: [{ repo: 'Org/alpha' }] }
  const beta = { id: 2, name: 'Beta', enabled: true, repos: [{ repo: 'Org/beta' }] }
  const { container, getByText, getByRole } = render(
    <NewItemModal projects={[alpha, beta]} defaultProjectId={1} onClose={noop} onCreated={noop} />,
  )
  const projectField = [...container.querySelectorAll('.field')].find(
    (f) => f.querySelector('.field__label')?.textContent === 'Project',
  )
  expect([...projectField.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Alpha', 'Beta'])
  expect(getByText(/Creates an issue in Org\/alpha/)).toBeTruthy()

  fireEvent.click(getByRole('button', { name: 'Beta' }))
  expect(getByText(/Creates an issue in Org\/beta/)).toBeTruthy()
  fireEvent.change(container.querySelector('input'), { target: { value: 'Cross-project work' } })
  const textareas = [...container.querySelectorAll('textarea')]
  fireEvent.change(textareas[0], { target: { value: 'A clear outcome for the farm to plan against.' } })
  fireEvent.change(textareas[1], { target: { value: 'A measurable success criterion.' } })
  fireEvent.click(getByText('Create work item'))

  await vi.waitFor(() => expect(createItem.mock.calls.at(-1)?.[0].title).toBe('Cross-project work'))
  expect(createItem.mock.calls.at(-1)[0].repo).toBe('Org/beta')
})
