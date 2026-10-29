// HZ-642 metrics 4-5: Approve & file's "Autopilot for filed items" select
// defaults to the project's own mode in an `on` project, and is disabled with
// the reason in an `off` or `shadow` project, where the override changes
// nothing.

import { afterEach, expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'
import FiledAutopilotSelect from './FiledAutopilotSelect'

afterEach(cleanup)

const plan = (projectAutopilot) => ({ id: 'PL-7', projectAutopilot })

test('in an on project it is enabled, defaults to "Project default (On)", and reports a pick', () => {
  const onChange = vi.fn()
  render(<FiledAutopilotSelect item={plan('on')} value="default" onChange={onChange} />)
  const select = screen.getByRole('combobox', { name: 'Autopilot for filed items' })
  expect(select.disabled).toBe(false)
  expect(select.selectedOptions[0].textContent).toBe('Project default (On)')
  expect(screen.queryByText(/for this project$/)).toBeNull()
  fireEvent.change(select, { target: { value: 'off' } })
  expect(onChange).toHaveBeenCalledWith('PL-7', 'off')
})

test.each(['off', 'shadow'])('in an %s project it is disabled and says "Autopilot is %s for this project"', (mode) => {
  render(<FiledAutopilotSelect item={plan(mode)} value="off" onChange={vi.fn()} />)
  const select = screen.getByRole('combobox', { name: 'Autopilot for filed items' })
  expect(select.disabled).toBe(true)
  // A stale pick from an `on` page never shows as chosen.
  expect(select.value).toBe('default')
  const note = screen.getByText(`Autopilot is ${mode} for this project`)
  expect(select.getAttribute('aria-describedby')).toBe(note.id)
})
