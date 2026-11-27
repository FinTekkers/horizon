import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { approveScreenshots, getScreenshotImage, getScreenshots } from '../api'
import { getShotLayout, setShotLayout, subscribeShotLayout } from '../shotLayout'
import ShotViewer, { VIEWER_LABEL } from './ShotViewer'

// HZ-509: the Accept gate's screenshot panel — one row per changed, new or
// removed shot of the item's latest publish, each approvable on its own or all
// at once. The server is the judge of everything shown: which shots are
// listed, and whether each approval still matches what the shot shows now
// (a later publish that changes a shot resets it). Approving here never
// approves the gate. No shots, no panel; a failed read says so instead of
// hiding the panel, so a removed shot is never skipped by accident.
//
// HZ-548: a loaded image opens the full-size viewer, which reuses the blob URLs
// held here; Stacked (remembered per browser) gives each image a full row.
//
// HZ-974: every shot starts as a collapsed row with no images. Expanding a row
// fetches that shot's images; collapsing keeps them, so re-opening is instant.
// Every image request goes through one 4-slot limiter, so Expand all never
// fetches more than 4 at once.

const IMAGE_LABEL = VIEWER_LABEL
const STATUS_LABEL = { changed: 'Changed', new: 'New', removed: 'Removed — will be deleted' }
const APPROVE_ERRORS = {
  pin_needed: 'Enter your gate PIN to approve screenshots.',
  human_gate_key_required: 'The gate PIN was not accepted — nothing was approved.',
  network: 'The server did not answer — nothing was approved.',
}
const STALE_NOTE = 'The screenshots changed since you opened them — reloaded. Review them again.'
const MAX_IN_FLIGHT = 4
const CANCELLED = new Error('cancelled')

// run(task) starts task() once fewer than `limit` tasks are running, in the
// order they were queued, and settles as task() does.
function createLimiter(limit) {
  let active = 0
  const queue = []
  const next = () => {
    while (active < limit && queue.length > 0) {
      const { task, resolve, reject } = queue.shift()
      active += 1
      let started
      try {
        started = Promise.resolve(task())
      } catch (err) {
        started = Promise.reject(err)
      }
      started.then(resolve, reject).finally(() => {
        active -= 1
        next()
      })
    }
  }
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject })
      next()
    })
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function ScreenshotPanel({ item }) {
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(() => new Set())
  const [images, setImages] = useState({})
  const [imageFailed, setImageFailed] = useState({})
  const [viewing, setViewing] = useState(null)
  const openerRef = useRef(null)
  // `screen/kind` → { started, cancelled } for each request queued or running.
  const requestedRef = useRef(new Map())
  const urlsRef = useRef([])
  // Bumped on every reset and on unmount: older work is dropped, its URLs revoked.
  const epochRef = useRef(0)
  const runRef = useRef(null)
  if (!runRef.current) runRef.current = createLimiter(MAX_IN_FLIGHT)
  // The panel's first image request, until a reset: the rest wait for it.
  const firstRef = useRef(null)
  const idPrefix = useId()
  const stacked = useSyncExternalStore(subscribeShotLayout, getShotLayout) === 'stacked'

  const load = useCallback(() => {
    // Promise.resolve first, so a throw and a rejection land in the same place.
    return Promise.resolve()
      .then(() => getScreenshots(item.id))
      .then((next) => {
        setData(next)
        setFailed(false)
      }, () => setFailed(true))
  }, [item.id])
  useEffect(() => {
    load()
  }, [load])

  // Drops every fetched image and closes every row, so nothing from an older
  // listing is ever shown.
  const resetImages = useCallback(() => {
    epochRef.current += 1
    urlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    urlsRef.current = []
    requestedRef.current = new Map()
    firstRef.current = null
    setImages({})
    setImageFailed({})
    setExpanded(new Set())
    setViewing(null)
  }, [])

  const commit = data?.commit ?? null
  const shots = data?.shots
  useEffect(() => {
    resetImages()
  }, [commit, item.id, resetImages])
  useEffect(
    () => () => {
      epochRef.current += 1
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      urlsRef.current = []
    },
    [],
  )

  // The first request runs alone, so a missing or wrong PIN is asked for once,
  // not once per image. It goes through the limiter like every other.
  function fetchKind(screen, kind) {
    const key = `${screen}/${kind}`
    if (requestedRef.current.has(key)) return
    const token = { started: false, cancelled: false }
    requestedRef.current.set(key, token)
    setImageFailed((prev) => (prev[key] ? { ...prev, [key]: false } : prev))
    const epoch = epochRef.current
    const first = firstRef.current
    const job = (first || Promise.resolve())
      .then(() =>
        runRef.current(() => {
          if (token.cancelled || epoch !== epochRef.current) throw CANCELLED
          token.started = true
          return getScreenshotImage(item.id, screen, kind)
        }),
      )
      .then(
        (url) => {
          if (epoch !== epochRef.current) return URL.revokeObjectURL(url)
          urlsRef.current.push(url)
          setImages((prev) => ({ ...prev, [key]: url }))
        },
        (err) => {
          if (epoch !== epochRef.current) return
          if (requestedRef.current.get(key) === token) requestedRef.current.delete(key)
          if (err !== CANCELLED) setImageFailed((prev) => ({ ...prev, [key]: true }))
        },
      )
    if (!first) firstRef.current = job
  }

  function fetchShot(shot) {
    shot.images.forEach((kind) => fetchKind(shot.screen, kind))
  }

  function toggle(shot) {
    const open = expanded.has(shot.screen)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (open) next.delete(shot.screen)
      else next.add(shot.screen)
      return next
    })
    if (!open) fetchShot(shot)
  }

  function expandAll() {
    setExpanded(new Set(shots.map((s) => s.screen)))
    shots.forEach(fetchShot)
  }

  // Requests not yet started are dropped; running ones finish and are kept.
  function collapseAll() {
    setExpanded(new Set())
    for (const [key, token] of requestedRef.current) {
      if (token.started) continue
      token.cancelled = true
      requestedRef.current.delete(key)
    }
  }

  async function approve(selection) {
    setBusy(true)
    setNotice(null)
    try {
      setData(await approveScreenshots(item.id, commit, selection))
    } catch (err) {
      setNotice(err.message === 'stale_snapshot' ? STALE_NOTE : APPROVE_ERRORS[err.message] || `Could not approve: ${err.message}`)
      if (err.message === 'stale_snapshot') {
        resetImages()
        await load()
      }
    } finally {
      setBusy(false)
    }
  }

  if (failed) {
    return (
      <section className="shots" aria-label="Screenshots">
        <h4 className="shots__title">Screenshots</h4>
        <p className="shots__error" role="alert">
          Screenshots unavailable — the server could not read them. Check the PR before accepting.
        </p>
        <button type="button" className="shots__btn" onClick={load}>Retry</button>
      </section>
    )
  }
  if (!shots || shots.length === 0) return null

  const approvedCount = shots.filter((s) => s.approved).length
  const openCount = shots.filter((s) => expanded.has(s.screen)).length
  const imageKeys = shots.flatMap((s) => s.images.map((kind) => `${s.screen}/${kind}`))
  const loadedCount = imageKeys.filter((key) => images[key]).length
  const loadingAll =
    openCount === shots.length && imageKeys.some((key) => !images[key] && !imageFailed[key])
  const viewedShot = viewing && shots.find((s) => s.screen === viewing.screen)
  const viewedKinds = viewedShot ? viewedShot.images.filter((kind) => images[`${viewedShot.screen}/${kind}`]) : []
  const viewer = viewedKinds.length > 0 && (
    <ShotViewer
      key={viewing.screen}
      screen={viewing.screen}
      kinds={viewedKinds}
      urls={Object.fromEntries(viewedKinds.map((kind) => [kind, images[`${viewing.screen}/${kind}`]]))}
      initialKind={viewing.kind}
      onClose={() => {
        setViewing(null)
        // A backup to the browser's own focus restore when the dialog closes.
        openerRef.current?.focus()
      }}
    />
  )
  return (
    <section className="shots" aria-label="Screenshots">
      <div className="shots__head">
        <h4 className="shots__title">Screenshots</h4>
        <span className="shots__count">{approvedCount} of {shots.length} approved</span>
        {loadingAll ? (
          <span className="shots__progress" role="status">
            <span className="shots__spin" aria-hidden="true" />
            Loading images · {loadedCount} of {imageKeys.length}
          </span>
        ) : (
          <button type="button" className="shots__btn shots__btn--quiet" disabled={openCount === shots.length} onClick={expandAll}>
            Expand all
          </button>
        )}
        <button type="button" className="shots__btn shots__btn--quiet" disabled={openCount === 0} onClick={collapseAll}>
          Collapse all
        </button>
        {openCount > 0 && (
          <button type="button" className="shots__btn" aria-pressed={stacked} onClick={() => setShotLayout(stacked ? 'side' : 'stacked')}>
            Stacked
          </button>
        )}
        <button
          type="button"
          className="shots__btn shots__btn--primary"
          disabled={busy || approvedCount === shots.length}
          onClick={() => approve({ all: true })}
        >
          Approve all
        </button>
      </div>
      {notice && <p className="shots__notice" role="status">{notice}</p>}
      <ul className="shots__list">
        {shots.map((shot, index) => {
          const open = expanded.has(shot.screen)
          const gridId = `${idPrefix}-shot-${index}`
          // The runner names a shot <screen>--<viewport>--<theme>.
          const [name, viewport, theme] = shot.screen.split('--')
          const cached = shot.images.length > 0 && shot.images.every((kind) => images[`${shot.screen}/${kind}`])
          return (
            <li className="shots__row" key={shot.screen} aria-label={shot.screen}>
              <div className="shots__row-head">
                <h5 className="shots__heading">
                  <button
                    type="button"
                    className="shots__toggle"
                    aria-expanded={open}
                    aria-controls={gridId}
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${shot.screen}`}
                    onClick={() => toggle(shot)}
                  >
                    <span className="shots__chev"><Chevron /></span>
                    <span className="shots__screen">{name}</span>
                    {(viewport || theme) && (
                      <span className="shots__tags">
                        {viewport && <span className="shots__tag">{viewport}</span>}
                        {theme && <span className="shots__tag">{theme}</span>}
                      </span>
                    )}
                    {!open && cached && <span className="shots__loaded-dot" title="Images loaded" />}
                  </button>
                </h5>
                <span className={`shots__status shots__status--${shot.status}`}>{STATUS_LABEL[shot.status]}</span>
                <span className="shots__spacer" />
                {shot.approved ? (
                  <span className="shots__approved" title={`Approved by ${shot.approvedBy}`}>✓ Approved</span>
                ) : (
                  <button type="button" className="shots__btn" disabled={busy} onClick={() => approve({ screens: [shot.screen] })}>
                    Approve
                  </button>
                )}
              </div>
              {shot.error && <p className="shots__shot-error">Could not compute a diff: {shot.error}</p>}
              <div id={gridId} className={`shots__images${stacked ? ' shots__images--stacked' : ''}`} hidden={!open}>
                {open &&
                  shot.images.map((kind) => {
                    const key = `${shot.screen}/${kind}`
                    let content
                    if (images[key]) {
                      content = (
                        <button
                          type="button"
                          className="shots__open"
                          title="Open full size"
                          onClick={(event) => {
                            openerRef.current = event.currentTarget
                            setViewing({ screen: shot.screen, kind })
                          }}
                        >
                          <img className="shots__img" src={images[key]} alt={IMAGE_LABEL[kind]} />
                        </button>
                      )
                    } else if (imageFailed[key]) {
                      content = (
                        <div className="shots__img-failed">
                          Image did not load
                          <button
                            type="button"
                            className="shots__btn"
                            aria-label={`Retry ${IMAGE_LABEL[kind]}`}
                            onClick={() => fetchKind(shot.screen, kind)}
                          >
                            Retry
                          </button>
                        </div>
                      )
                    } else {
                      content = <div className="shots__placeholder" aria-hidden="true" />
                    }
                    return (
                      <figure className="shots__figure" key={kind}>
                        <figcaption className="shots__caption">{IMAGE_LABEL[kind]}</figcaption>
                        {content}
                      </figure>
                    )
                  })}
              </div>
            </li>
          )
        })}
      </ul>
      {viewer}
    </section>
  )
}
