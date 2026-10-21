import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { captureFrame, launch, openBoard, renderCard, shootSite, showsLogin } from './browser.mjs'
import { encode } from './encode.mjs'
import { RecorderError } from './errors.mjs'
import { buildTimeline } from './timeline.mjs'
import { readToken } from './token.mjs'
import { pollItem } from './watch.mjs'

export const USAGE = `Usage: node scripts/record-item.mjs <ITEM-ID> [--site <url>] [--out <dir>] [--board <url>]

Films one work item on the board and cuts it into a short time-lapse MP4.
  --board  the board's base URL (default https://shoreward.ai/horizon)
  --site   a page shot full-length at the start and at the end (before/after cards)
  --out    output directory (default ./recordings/<ITEM-ID>)
Writes <out>/<ITEM-ID>.mp4, <out>/frames/ and <out>/timeline.json.

The token is read only from the env file named by HORIZON_RECORDER_ENV
(a HORIZON_TOKEN=... line). The recorder only sends GET requests.

Exit codes:
  0  the item closed or was abandoned; the outputs are written
  1  bad usage, missing token file, ffmpeg failure, or the board showed the login screen
  2  token rejected (401)
  3  item <ITEM-ID> not on board (3 polls in a row)
  4  board unreachable for 5 minutes
`

const DEFAULT_BOARD = 'https://shoreward.ai/horizon'
const GIVE_UP_MS = 5 * 60 * 1000

export async function run(argv, env = process.env, log = (line) => process.stdout.write(`${line}\n`)) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { site: { type: 'string' }, out: { type: 'string' }, board: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    })
  } catch (err) {
    throw new RecorderError(`${err.message}\n\n${USAGE}`)
  }
  const { values, positionals } = parsed
  if (values.help) {
    log(USAGE)
    return
  }
  const itemId = positionals[0]
  if (positionals.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(itemId)) throw new RecorderError(`expected one item id\n\n${USAGE}`)
  const boardUrl = (values.board || DEFAULT_BOARD).replace(/\/+$/, '')
  const outDir = path.resolve(values.out || path.join('recordings', itemId))
  const pollMs = positiveInt(env.RECORDER_POLL_MS, 5000)
  const heartbeatMs = positiveInt(env.RECORDER_HEARTBEAT_MS, 30000)
  const settleMs = positiveInt(env.RECORDER_SETTLE_MS, 1500)

  const token = await readToken(env)
  try {
    await record({ itemId, boardUrl, outDir, site: values.site, token, pollMs, heartbeatMs, settleMs, log })
  } catch (err) {
    // Belt and braces: no error text reaches stderr with the token in it.
    if (err && typeof err.message === 'string' && err.message.includes(token)) err.message = err.message.split(token).join('<token>')
    if (err && typeof err.stack === 'string') err.stack = err.stack.split(token).join('<token>')
    throw err
  }
}

async function record({ itemId, boardUrl, outDir, site, token, pollMs, heartbeatMs, settleMs, log }) {
  const framesDir = path.join(outDir, 'frames')
  await rm(framesDir, { recursive: true, force: true })
  await mkdir(framesDir, { recursive: true })
  const abs = (rel) => path.join(outDir, rel)

  const browser = await launch()
  try {
    let before = null
    let after = null
    if (site) {
      await shootSite(browser, site, abs('frames/before.png'))
      before = { file: 'frames/before.png', at: Date.now(), url: site }
      log(`before: ${site}`)
    }

    const board = await openBoard(browser, { boardUrl, itemId, token })
    const { page } = board
    await page.waitForTimeout(settleMs)
    if (await showsLogin(page)) throw new RecorderError('the board showed the login screen: the /api/auth/me shim no longer gets the UI past login')

    let frameNo = 0
    let lastFrameAt = 0
    const shoot = async () => {
      frameNo += 1
      const file = `frames/${String(frameNo).padStart(4, '0')}.png`
      const { hash } = await captureFrame(page, abs(file))
      lastFrameAt = Date.now()
      return { file, hash }
    }
    const fresh = async () => {
      await page.reload({ waitUntil: 'load' })
      await page.waitForTimeout(settleMs)
    }

    const poll = poller({ apiBase: `${boardUrl}/api`, itemId, token, pollMs })
    const steps = []
    let cur = null
    for (;;) {
      const state = await poll()
      const now = Date.now()
      if (state.done) {
        const end = state.endedAt ?? now
        if (!cur) {
          cur = { key: null, step: state.label, realStart: end, frames: [] }
          steps.push(cur)
        }
        await fresh()
        cur.frames.push(await shoot())
        cur.realEnd = Math.max(cur.realStart, end)
        log(`${state.done}: ${itemId}`)
        break
      }
      const key = `${state.cursor}|${state.label}`
      if (!cur || key !== cur.key) {
        const start = Math.max(state.startedAt ?? now, cur ? cur.realStart : -Infinity)
        if (cur) cur.realEnd = start
        cur = { key, step: state.label, realStart: start, frames: [] }
        steps.push(cur)
        log(`step: ${state.label}`)
        if (steps.length > 1) await fresh()
        cur.frames.push(await shoot())
      } else if (Date.now() - lastFrameAt >= heartbeatMs) {
        cur.frames.push(await shoot())
      }
      await sleep(pollMs)
    }
    await board.close()

    if (site) {
      await shootSite(browser, site, abs('frames/after.png'))
      after = { file: 'frames/after.png', at: Date.now(), url: site }
      log(`after: ${site}`)
    }

    const entries = buildTimeline({ steps, before, after })
    for (const e of entries) {
      if (e.kind === 'card') await renderCard(browser, { background: abs(e.from), caption: e.caption, file: abs(e.frame) })
      else if (e.kind === 'before' || e.kind === 'after') await renderCard(browser, { background: abs(e.frame), caption: e.caption, file: abs(e.shown[0].frame) })
    }
    await writeFile(abs('timeline.json'), `${JSON.stringify(entries, null, 2)}\n`)
    const mp4 = abs(`${itemId}.mp4`)
    await encode(entries, outDir, mp4)
    log(`wrote ${mp4} (${entries.length} timeline entries)`)
  } finally {
    await browser.close()
  }
}

// One poll per call. A missing item 3 polls in a row is exit 3; network
// failures retry with backoff until GIVE_UP_MS, then exit 4. A 401 (exit 2)
// is thrown by pollItem straight away.
function poller({ apiBase, itemId, token, pollMs }) {
  let missing = 0
  return async () => {
    let failingSince = null
    let backoff = pollMs
    for (;;) {
      let state
      try {
        state = await pollItem({ apiBase, itemId, token })
      } catch (err) {
        if (err instanceof RecorderError) throw err
        failingSince ??= Date.now()
        if (Date.now() - failingSince > GIVE_UP_MS) throw new RecorderError(`board unreachable for 5 minutes: ${err.message}`, 4)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30000)
        continue
      }
      if (state) {
        missing = 0
        return state
      }
      missing += 1
      if (missing >= 3) throw new RecorderError(`item ${itemId} not on board`, 3)
      await sleep(pollMs)
    }
  }
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
