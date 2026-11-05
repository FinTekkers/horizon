import { useEffect, useRef, useState } from 'react'

const COPY = {
  approve: {
    title: 'Approve with comments',
    submitLabel: 'Approve',
    submitColor: 'var(--success)',
    placeholder: 'Decision notes — e.g. which option to adopt, or conditions for the next step…',
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

// HZ-711: Return to and Retry are MoveDialog's; this composer keeps the modes
// that are not a step change.
function subtitle(composer) {
  if (composer.mode === 'approve') {
    return `Approves ${composer.target || 'the gate'}; your notes are delivered to the next agent and recorded on the issue`
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
  const copy = COPY[composer.mode] || COPY.approve
  // HZ-354: abandoning an item that blocks others lists them, with an option
  // (on by default) to remove their links to it in the same request.
  const dependents = composer.mode === 'abandon' ? composer.dependents || [] : []
  const [removeDependentLinks, setRemoveDependentLinks] = useState(true)
  // HZ-470: Kill stays open until its request settles — Cancel, Esc and the
  // scrim do nothing meanwhile. Amend the rule keeps its Cancel.
  const locked = composer.busy === true && composer.mode === 'abandon'
  const cancel = () => {
    if (!locked) onCancel()
  }
  const submit = () => {
    if (composer.busy) return
    const text = (inputRef.current?.value || '').trim()
    // Abandon (HZ-59) demands a reason — the modes that require text must not
    // submit empty.
    if (copy.required && !text) {
      inputRef.current?.focus()
      return
    }
    if (composer.mode === 'abandon') {
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
        cancel()
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
      <div className="composer__scrim" onClick={cancel} />
      <div className="composer__panel" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <div className="composer__title" id="composer-title">
          {copy.title} · {composer.itemId}
        </div>
        <div className="composer__sub">{subtitle(composer)}</div>
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
        {/* HZ-389: a request that did not go through says why; the text
            stays, so it can be sent again. */}
        {composer.error && <span role="alert">{composer.error}</span>}
        <div className="composer__actions">
          <button className="composer__cancel" disabled={locked} onClick={cancel}>
            Cancel
          </button>
          <button
            className="composer__submit"
            style={{ background: copy.submitColor }}
            disabled={composer.busy}
            aria-busy={composer.busy || undefined}
            onClick={submit}
          >
            {copy.submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
