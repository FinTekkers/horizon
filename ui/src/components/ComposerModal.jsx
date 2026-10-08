import { useEffect, useRef, useState } from 'react'
import { PHASES } from '../../../domain/js/lifecycle.js'

const COPY = {
  approve: {
    title: 'Approve with comments',
    submitLabel: 'Approve',
    submitColor: 'var(--success)',
    placeholder: 'Decision notes — e.g. which option to adopt, or conditions for the next step…',
  },
  reject: {
    title: 'Send back with feedback',
    submitLabel: 'Send back',
    submitColor: 'var(--danger)',
    placeholder: 'What should change, or what question needs answering?',
  },
  restart: {
    title: 'Restart phase',
    submitLabel: 'Restart phase',
    submitColor: 'var(--warning)',
    placeholder: 'Why are you restarting? (optional)',
  },
  abandon: {
    title: 'Abandon this item',
    submitLabel: 'Abandon',
    submitColor: '#5C1F2B',
    placeholder: 'Why is this being abandoned? (required)',
    required: true,
  },
  // HZ-365: the rule-block banner's Amend the rule.
  amend: {
    title: 'Amend the rule',
    submitLabel: 'Send ruling',
    submitColor: 'var(--primary)',
    placeholder: 'Your ruling on the blocking rule — e.g. a local workaround is allowed here (required)',
    required: true,
  },
}

function subtitle(composer) {
  if (composer.mode === 'approve') {
    return `Approves ${composer.target || 'the gate'}; your notes are delivered to the next agent and recorded on the issue`
  }
  if (composer.mode === 'reject') {
    return `The responsible agent re-runs the step and must address your notes${composer.target ? ' · ' + composer.target : ''}`
  }
  if (composer.mode === 'restart' && composer.phase != null) {
    return `${PHASES[composer.phase]} phase will re-run from the start`
  }
  if (composer.mode === 'abandon') {
    return 'Stops dispatch, cancels any in-flight run, and closes the GitHub issue as not planned — this is recorded on the activity feed and cannot be undone from here'
  }
  if (composer.mode === 'amend') {
    return "Your ruling goes to the implement agent, the block clears and implement re-runs. The issue's guardrails and metric are not changed. Needs your gate PIN."
  }
  return ''
}

export default function ComposerModal({ composer, onSubmit, onCancel }) {
  const inputRef = useRef(null)
  const copy = COPY[composer.mode] || COPY.reject
  // Only a reject from a gate offers a destination — everywhere else this
  // stays empty and the picker doesn't render.
  const stepOptions = composer.mode === 'reject' ? composer.stepOptions || [] : []
  const [targetStepIndex, setTargetStepIndex] = useState('')
  // HZ-354: abandoning an item that blocks others lists them, with an option
  // (on by default) to remove their links to it in the same request.
  const dependents = composer.mode === 'abandon' ? composer.dependents || [] : []
  const [removeDependentLinks, setRemoveDependentLinks] = useState(true)
  const submit = () => {
    const text = (inputRef.current?.value || '').trim()
    // Abandon (HZ-59) demands a reason — the modes that require text must not
    // submit empty. This guard came from this branch; the reject/step-target
    // routing below came from main (HZ-51). Both are needed.
    if (copy.required && !text) {
      inputRef.current?.focus()
      return
    }
    if (composer.mode === 'reject') {
      onSubmit(text, stepOptions.length && targetStepIndex !== '' ? Number(targetStepIndex) : null)
    } else if (composer.mode === 'abandon') {
      onSubmit(text, { removeDependentLinks: dependents.length > 0 && removeDependentLinks })
    } else {
      onSubmit(text)
    }
  }

  // The textarea needs plain Enter for newlines, so this decision's explicit
  // "confirm" keystroke is Ctrl/Cmd+Enter instead — same convention as
  // Slack/GitHub comment boxes. Esc still cancels outright.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="composer">
      <div className="composer__scrim" onClick={onCancel} />
      <div className="composer__panel" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <div className="composer__title" id="composer-title">
          {copy.title} · {composer.itemId}
        </div>
        <div className="composer__sub">{subtitle(composer)}</div>
        {stepOptions.length > 0 && (
          <div className="composer__field">
            <label htmlFor="composer-target-step" className="composer__field-label">
              Send back to
            </label>
            <select
              id="composer-target-step"
              className="composer__select"
              value={targetStepIndex}
              onChange={(e) => setTargetStepIndex(e.target.value)}
            >
              <option value="">Default — {composer.defaultTargetLabel}</option>
              {stepOptions.map((opt) => (
                <option key={opt.index} value={opt.index}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {dependents.length > 0 && (
          <div className="composer__field">
            <div className="composer__field-label">This item blocks</div>
            <ul className="composer__dependents">
              {dependents.map((d) => (
                <li key={d.id}>
                  {d.id} — {d.title}
                </li>
              ))}
            </ul>
            <label className="composer__check">
              <input
                type="checkbox"
                checked={removeDependentLinks}
                onChange={(e) => setRemoveDependentLinks(e.target.checked)}
              />
              Remove these links
            </label>
          </div>
        )}
        <textarea ref={inputRef} className="composer__input" placeholder={copy.placeholder} autoFocus />
        <div className="composer__hint">⌘/Ctrl + Enter to submit · Esc to cancel</div>
        <div className="composer__actions">
          <button className="composer__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="composer__submit" style={{ background: copy.submitColor }} onClick={submit}>
            {copy.submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
