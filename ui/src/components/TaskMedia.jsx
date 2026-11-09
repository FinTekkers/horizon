// HZ-815: the videos and images a Task's run declared as `outputs`, played
// and shown inline on its Execute, Verify & report and Review & close cards.
// The list is the server's stepOutputs[Execute].job.media (server/src/
// orchestrator.js cleanJobMedia); each stored file streams from the item's
// own member-only route (mediaUrl), never a public URL. An SVG is shown only
// through <img>, never inline. A file the run did not store shows its name,
// size and why, with no player; one that fails to load says so.

import { useState } from 'react'
import { mediaUrl } from '../api'

export function formatBytes(n) {
  const bytes = Number.isFinite(n) && n > 0 ? n : 0
  for (const [unit, scale] of [
    ['GB', 1024 ** 3],
    ['MB', 1024 ** 2],
    ['KB', 1024],
  ]) {
    if (bytes >= scale) return `${(bytes / scale).toFixed(1)} ${unit}`
  }
  return `${bytes} B`
}

export function formatDuration(seconds) {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function MediaFile({ itemId, file }) {
  const [failed, setFailed] = useState(false)
  const stored = file.status === 'stored'
  const details = [formatBytes(file.bytes)]
  if (file.durationS > 0) details.push(formatDuration(file.durationS))
  if (file.width && file.height) details.push(`${file.width}×${file.height}`)
  const src = stored ? mediaUrl(itemId, file.name) : null
  return (
    <figure className="task-media__file" data-testid="task-media-file">
      {stored && !failed && file.kind === 'video' && (
        <video className="task-media__player" src={src} controls preload="metadata" playsInline onError={() => setFailed(true)} />
      )}
      {stored && !failed && file.kind !== 'video' && (
        <img className="task-media__image" src={src} alt={file.name} loading="lazy" onError={() => setFailed(true)} />
      )}
      {failed && (
        <div className="task-media__error" role="alert">
          Could not load this file. The farm may be down; try again in a moment.
        </div>
      )}
      <figcaption className="task-media__caption">
        <code className="task-media__name">{file.name}</code>
        <span className="task-media__details">{details.join(' · ')}</span>
        {!stored && (
          <span className="task-media__reason">
            Not stored{file.status === 'over_cap' ? ' (too large)' : ''}: {file.reason || file.status}
          </span>
        )}
      </figcaption>
    </figure>
  )
}

export default function TaskMedia({ itemId, media }) {
  const files = Array.isArray(media) ? media.filter((f) => f && typeof f.name === 'string') : []
  if (files.length === 0) return null
  return (
    <div className="task-media" data-testid="task-media">
      <div className="task-media__title">
        Outputs · {files.length} file{files.length === 1 ? '' : 's'}
      </div>
      {files.map((file) => (
        <MediaFile key={file.name} itemId={itemId} file={file} />
      ))}
    </div>
  )
}
