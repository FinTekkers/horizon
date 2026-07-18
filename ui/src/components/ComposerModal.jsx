import { useRef } from 'react'
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
}

function subtitle(composer) {
  if (composer.mode === 'approve') {
    return 'Approves the gate; your notes are delivered to the next agent and recorded on the issue'
  }
  if (composer.mode === 'reject') {
    return `The responsible agent re-runs the step and must address your notes${composer.target ? ' · ' + composer.target : ''}`
  }
  if (composer.mode === 'restart' && composer.phase != null) {
    return `${PHASES[composer.phase]} phase will re-run from the start`
  }
  return ''
}

export default function ComposerModal({ composer, onSubmit, onCancel }) {
  const inputRef = useRef(null)
  const copy = COPY[composer.mode] || COPY.reject

  return (
    <div className="composer">
      <div className="composer__scrim" onClick={onCancel} />
      <div className="composer__panel">
        <div className="composer__title">{copy.title}</div>
        <div className="composer__sub">{subtitle(composer)}</div>
        <textarea ref={inputRef} className="composer__input" placeholder={copy.placeholder} autoFocus />
        <div className="composer__actions">
          <button className="composer__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="composer__submit"
            style={{ background: copy.submitColor }}
            onClick={() => onSubmit((inputRef.current?.value || '').trim())}
          >
            {copy.submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
