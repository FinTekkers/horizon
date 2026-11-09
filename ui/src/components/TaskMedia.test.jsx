// HZ-815: a Task's stored output media plays inline — a <video controls> for
// an MP4, an <img> for a JPG — each with its file name and size; a file the
// run did not store shows why, with no player.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within, fireEvent } from '@testing-library/react'

vi.mock('../api', () => ({
  mediaUrl: (id, name) => `/horizon/api/items/${id}/media/${encodeURIComponent(name)}`,
}))

import TaskMedia, { formatBytes, formatDuration } from './TaskMedia'

afterEach(() => cleanup())

const file = (name, kind, mime, bytes, extra = {}) => ({
  name,
  path: `out/${name}`,
  kind,
  mime,
  bytes,
  durationS: null,
  width: null,
  height: null,
  status: 'stored',
  reason: null,
  ...extra,
})
const MEDIA = [
  file('ch1-cut.mp4', 'video', 'video/mp4', 13002342, { durationS: 94.2, width: 1920, height: 1080 }),
  file('poster.jpg', 'image', 'image/jpeg', 245760, { width: 1280, height: 720 }),
]

function captionOf(scope, name) {
  return within(scope).getByText(name).closest('figure')
}

test('the MP4 is a <video controls> and the JPG an <img>, each with its name and size', () => {
  const { container } = render(<TaskMedia itemId="T-815" media={MEDIA} />)
  const video = captionOf(container, 'ch1-cut.mp4').querySelector('video')
  expect(video).not.toBeNull()
  expect(video.hasAttribute('controls')).toBe(true)
  expect(video.getAttribute('preload')).toBe('metadata')
  expect(video.hasAttribute('playsinline')).toBe(true)
  expect(video.getAttribute('src')).toBe('/horizon/api/items/T-815/media/ch1-cut.mp4')
  expect(within(captionOf(container, 'ch1-cut.mp4')).getByText('12.4 MB · 1:34 · 1920×1080')).toBeTruthy()

  const img = captionOf(container, 'poster.jpg').querySelector('img')
  expect(img).not.toBeNull()
  expect(img.getAttribute('src')).toBe('/horizon/api/items/T-815/media/poster.jpg')
  expect(img.getAttribute('alt')).toBe('poster.jpg')
  expect(within(captionOf(container, 'poster.jpg')).getByText('240.0 KB · 1280×720')).toBeTruthy()
  expect(container.querySelectorAll('video')).toHaveLength(1)
  expect(container.querySelectorAll('img')).toHaveLength(1)
})

test('an SVG is only ever an <img>', () => {
  const { container } = render(<TaskMedia itemId="T-815" media={[file('diagram.svg', 'image', 'image/svg+xml', 812)]} />)
  expect(container.querySelector('img').getAttribute('src')).toBe('/horizon/api/items/T-815/media/diagram.svg')
  expect(container.querySelector('svg')).toBeNull()
  expect(container.querySelector('object, iframe, embed')).toBeNull()
})

test('a file the run did not store shows its name, size and reason, with no player', () => {
  const media = [
    file('leak.jpg', 'image', 'image/jpeg', 0, { status: 'refused', reason: "outside the run's checkout and media roots" }),
    file('huge.mp4', 'video', 'video/mp4', 300 * 1024 * 1024, { status: 'over_cap', reason: 'over the 200.0 MB per-file cap' }),
  ]
  const { container } = render(<TaskMedia itemId="T-815" media={media} />)
  expect(container.querySelector('video, img')).toBeNull()
  expect(within(captionOf(container, 'leak.jpg')).getByText("Not stored: outside the run's checkout and media roots")).toBeTruthy()
  expect(within(captionOf(container, 'huge.mp4')).getByText('300.0 MB')).toBeTruthy()
  expect(within(captionOf(container, 'huge.mp4')).getByText(/Not stored \(too large\)/)).toBeTruthy()
})

test('a file that fails to load says so instead of a blank player', () => {
  const { container } = render(<TaskMedia itemId="T-815" media={MEDIA} />)
  fireEvent.error(container.querySelector('video'))
  const alert = within(captionOf(container, 'ch1-cut.mp4')).getByRole('alert')
  expect(alert.textContent).toMatch(/could not load/i)
  expect(container.querySelector('video')).toBeNull()
  expect(container.querySelector('img')).not.toBeNull()
})

test('no media renders nothing', () => {
  for (const media of [undefined, null, []]) {
    const { container } = render(<TaskMedia itemId="T-815" media={media} />)
    expect(container.innerHTML).toBe('')
    cleanup()
  }
})

test('sizes and durations read as the card shows them', () => {
  expect([formatBytes(0), formatBytes(812), formatBytes(4300), formatBytes(13002342), formatBytes(1024 ** 3)]).toEqual([
    '0 B',
    '812 B',
    '4.2 KB',
    '12.4 MB',
    '1.0 GB',
  ])
  expect([formatDuration(9.6), formatDuration(94.2), formatDuration(3600)]).toEqual(['0:10', '1:34', '60:00'])
})
