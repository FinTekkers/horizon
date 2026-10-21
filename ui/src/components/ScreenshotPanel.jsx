import { useCallback, useEffect, useState } from 'react'
import { approveScreenshots, getScreenshotImage, getScreenshots, hasGatePin } from '../api'

// HZ-509: the Accept gate's screenshot panel — one row per changed, new or
// removed shot of the item's latest publish, each approvable on its own or all
// at once. The server is the judge of everything shown: which shots are
// listed, and whether each approval still matches what the shot shows now
// (a later publish that changes a shot resets it). Approving here never
// approves the gate. No shots, no panel; a failed read says so instead of
// hiding the panel, so a removed shot is never skipped by accident.

const IMAGE_LABEL = { baseline: 'Baseline', new: 'New', diff: 'Diff' }
const STATUS_LABEL = { changed: 'Changed', new: 'New', removed: 'Removed — will be deleted' }
const APPROVE_ERRORS = {
  pin_needed: 'Enter your gate PIN to approve screenshots.',
  human_gate_key_required: 'The gate PIN was not accepted — nothing was approved.',
  network: 'The server did not answer — nothing was approved.',
}
const STALE_NOTE = 'The screenshots changed since you opened them — reloaded. Review them again.'

export default function ScreenshotPanel({ item }) {
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showImages, setShowImages] = useState(() => hasGatePin())
  const [images, setImages] = useState({})

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

  // Images load once per publish. The first request runs alone, so a missing
  // or wrong PIN is asked for once, not once per image.
  const commit = data?.commit ?? null
  const shots = data?.shots
  const wantedKey = JSON.stringify((shots || []).flatMap((s) => s.images.map((kind) => [s.screen, kind])))
  useEffect(() => {
    if (!showImages || !commit) return undefined
    let live = true
    const urls = []
    const fetchOne = ([screen, kind]) =>
      getScreenshotImage(item.id, screen, kind).then((url) => {
        if (!live) return URL.revokeObjectURL(url)
        urls.push(url)
        setImages((prev) => ({ ...prev, [`${screen}/${kind}`]: url }))
      }, () => {})
    const [first, ...rest] = JSON.parse(wantedKey)
    setImages({})
    if (first) fetchOne(first).then(() => live && Promise.all(rest.map(fetchOne)))
    return () => {
      live = false
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [showImages, commit, wantedKey, item.id])

  async function approve(selection) {
    setBusy(true)
    setNotice(null)
    try {
      setData(await approveScreenshots(item.id, commit, selection))
    } catch (err) {
      setNotice(err.message === 'stale_snapshot' ? STALE_NOTE : APPROVE_ERRORS[err.message] || `Could not approve: ${err.message}`)
      if (err.message === 'stale_snapshot') await load()
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
  return (
    <section className="shots" aria-label="Screenshots">
      <div className="shots__head">
        <h4 className="shots__title">Screenshots</h4>
        <span className="shots__count">{approvedCount} of {shots.length} approved</span>
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
      {!showImages && (
        <button type="button" className="shots__btn" onClick={() => setShowImages(true)}>Show images</button>
      )}
      <ul className="shots__list">
        {shots.map((shot) => (
          <li className="shots__row" key={shot.screen} aria-label={shot.screen}>
            <div className="shots__row-head">
              <h5 className="shots__screen">{shot.screen}</h5>
              <span className={`shots__status shots__status--${shot.status}`}>{STATUS_LABEL[shot.status]}</span>
              {shot.approved ? (
                <span className="shots__approved" title={`Approved by ${shot.approvedBy}`}>✓ Approved</span>
              ) : (
                <button type="button" className="shots__btn" disabled={busy} onClick={() => approve({ screens: [shot.screen] })}>
                  Approve
                </button>
              )}
            </div>
            {shot.error && <p className="shots__shot-error">Could not compute a diff: {shot.error}</p>}
            {showImages && shot.images.length > 0 && (
              <div className="shots__images">
                {shot.images.map((kind) => (
                  <figure className="shots__figure" key={kind}>
                    <figcaption className="shots__caption">{IMAGE_LABEL[kind]}</figcaption>
                    {images[`${shot.screen}/${kind}`] ? (
                      <img className="shots__img" src={images[`${shot.screen}/${kind}`]} alt={IMAGE_LABEL[kind]} />
                    ) : (
                      <div className="shots__placeholder" aria-hidden="true" />
                    )}
                  </figure>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
