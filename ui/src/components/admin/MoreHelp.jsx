import { useId, useState } from 'react'

// HZ-764: long help text, folded behind a "More" toggle on the repository page.
// The text stays in the page while folded (hidden), so it is one click away
// and never re-mounted.
export function MoreHelp({ label = 'More', children }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="more-help">
      <button type="button" className="more-help__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
      </button>
      <div id={id} className="more-help__body" hidden={!open}>
        {children}
      </div>
    </div>
  )
}
