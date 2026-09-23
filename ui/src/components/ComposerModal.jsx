import { useEffect, useRef } from 'react'
import { PHASES } from '../domain/lifecycle'

const COPY = {
  approve: {
    title: 'Approve with comments',
    submitLabel: 'Approve',
    submitColor: '#0E6E74',
    placeholder: 'Decision notes — e.g. which option to adopt, or conditions for the next step…',
  },
  reject: {
    title: 'Send back with feedback',
    submitLabel: 'Send back',
    submitColor: '#9C333E',
    placeholder: 'What should change, or what question needs answering?',
  },
  restart: {
    title: 'Restart phase',
    submitLabel: 'Restart phase',
    submitColor: '#DFA200',
    placeholder: 'Why are you restarting? (optional)',
  },
  abandon: {
    title: 'Abandon this item',
    submitLabel: 'Abandon',
    submitColor: '#5C1F2B',
    placeholder: 'Why is this being abandoned? (required)',
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
  return ''
}

export default function ComposerModal({ composer, onSubmit, onCancel }) {
  const inputRef = useRef(null)
  const copy = COPY[composer.mode] || COPY.reject
  const submit = () => {
    const text = (inputRef.current?.value || '').trim()
    if (copy.required && !text) {
      inputRef.current?.focus()
      return
    }
    onSubmit(text)
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
