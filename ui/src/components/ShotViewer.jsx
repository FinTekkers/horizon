import { useEffect, useRef, useState } from 'react'

// HZ-548: one screenshot at full size, over the page. A native modal <dialog>
// gives the focus trap, the inert page behind it, Esc and the top layer; the
// body scrolls on both axes so a shot keeps its natural width. Tabs switch
// between the images the panel has already loaded (it never fetches), and
// Swipe lays the baseline over the current image with a draggable divider.

export const VIEWER_LABEL = { baseline: 'Baseline', new: 'Current', diff: 'Diff' }
const STEP = 5

const clamp = (n) => Math.min(100, Math.max(0, Math.round(n)))

export default function ShotViewer({ screen, kinds, urls, initialKind, onClose }) {
  const dialogRef = useRef(null)
  const boxRef = useRef(null)
  const tabRefs = useRef({})
  const [picked, setPicked] = useState(initialKind)
  const [swipe, setSwipe] = useState(false)
  const [pct, setPct] = useState(50)
  // A republish can take the picked image away while the viewer is open.
  const kind = kinds.includes(picked) ? picked : kinds[0]
  const canSwipe = kinds.includes('baseline') && kinds.includes('new')

  useEffect(() => {
    const dialog = dialogRef.current
    // StrictMode runs this twice; a second showModal() on an open dialog throws.
    if (!dialog.open) dialog.showModal()
    tabRefs.current[kind]?.focus()
    return () => {
      if (dialog.open) dialog.close()
    }
    // Opening runs once; later tab changes move focus themselves.
  }, [])

  function select(next) {
    setPicked(next)
    setSwipe(false)
    tabRefs.current[next]?.focus()
  }

  // Left/Right move between tabs only while a tab has focus, so the slider,
  // Swipe and Close keep their own keys. Left on the first tab wraps to the last.
  function onTabKey(event) {
    const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
    if (!delta) return
    event.preventDefault()
    select(kinds[(kinds.indexOf(kind) + delta + kinds.length) % kinds.length])
  }

  // The modal makes the page inert, but Chrome still lets Tab leave for the
  // browser's own controls; wrap it at either end so focus stays in the viewer.
  function onTrapKey(event) {
    if (event.key !== 'Tab') return
    const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), [tabindex]')].filter((el) => el.tabIndex >= 0)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function dragTo(event) {
    const rect = boxRef.current.getBoundingClientRect()
    if (rect.width > 0) setPct(clamp(((event.clientX - rect.left) / rect.width) * 100))
  }

  function onSliderKey(event) {
    const next = { ArrowLeft: pct - STEP, ArrowDown: pct - STEP, ArrowRight: pct + STEP, ArrowUp: pct + STEP, Home: 0, End: 100 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    setPct(clamp(next))
  }

  const alt = (k) => `${screen} — ${VIEWER_LABEL[k]}`
  return (
    // Esc fires cancel then close; close (from Esc or the button) is the one
    // path back to the panel. The open check skips a close queued by a
    // StrictMode remount that has since reopened the dialog.
    <dialog
      ref={dialogRef}
      className="shot-viewer"
      aria-label={`${screen} screenshot`}
      onKeyDown={onTrapKey}
      onClose={() => {
        if (!dialogRef.current?.open) onClose()
      }}
    >
      <div className="shot-viewer__head">
        <h2 className="shot-viewer__title">{screen}</h2>
        <div className="shot-viewer__tabs" role="tablist" aria-label="Image">
          {kinds.map((k) => (
            <button
              key={k}
              ref={(el) => {
                tabRefs.current[k] = el
              }}
              type="button"
              role="tab"
              className="shot-viewer__tab"
              aria-selected={!swipe && k === kind}
              tabIndex={k === kind ? 0 : -1}
              onClick={() => select(k)}
              onKeyDown={onTabKey}
            >
              {VIEWER_LABEL[k]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="shots__btn"
          aria-pressed={swipe}
          disabled={!canSwipe}
          title={canSwipe ? undefined : 'Swipe needs both a baseline and a current image'}
          onClick={() => setSwipe((on) => !on)}
        >
          Swipe
        </button>
        <button type="button" className="shots__btn shot-viewer__close" onClick={() => dialogRef.current.close()}>
          Close
        </button>
      </div>
      {/* Focusable, so the keyboard can scroll a shot larger than the screen. */}
      <div className="shot-viewer__body" tabIndex={0} role="group" aria-label={`${screen} image`}>
        {swipe && canSwipe ? (
          <div className="shot-viewer__swipe" ref={boxRef}>
            <img className="shot-viewer__img shot-viewer__layer" src={urls.new} alt={alt('new')} />
            <img
              className="shot-viewer__img shot-viewer__layer"
              src={urls.baseline}
              alt={alt('baseline')}
              style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
            />
            <button
              type="button"
              role="slider"
              className="shot-viewer__divider"
              style={{ left: `${pct}%` }}
              aria-label="Baseline share"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={`${pct}% baseline`}
              onKeyDown={onSliderKey}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture?.(event.pointerId)
                dragTo(event)
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture?.(event.pointerId)) dragTo(event)
              }}
            />
          </div>
        ) : (
          <img className="shot-viewer__img" src={urls[kind]} alt={alt(kind)} />
        )}
      </div>
    </dialog>
  )
}
