import { spawn } from 'node:child_process'
import { rename, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { RecorderError } from './errors.mjs'

// Joins every entry's `shown` frames into <outFile> with ffmpeg's concat
// demuxer. Frames of any size are scaled and padded onto one 1280×720 canvas.
export async function encode(entries, outDir, outFile) {
  const shown = entries.flatMap((e) => e.shown)
  if (!shown.length) throw new RecorderError('nothing to encode: no frames were captured')
  const lines = ['ffconcat version 1.0']
  for (const s of shown) lines.push(`file '${s.frame}'`, `duration ${s.seconds}`)
  // The concat demuxer drops the last entry's duration unless the file repeats.
  lines.push(`file '${shown[shown.length - 1].frame}'`)
  const list = path.join(outDir, 'concat.txt')
  await writeFile(list, `${lines.join('\n')}\n`)
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0b1020,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-movflags', '+faststart',
      outFile,
    ])
  } finally {
    await rm(list, { force: true })
  }
}

// A walkthrough's recordVideo .webm, cut to [startSec, startSec + durationSec]
// and encoded like encode() does. ffmpeg writes <outFile>.part, which is only
// renamed once it is whole, so a failed encode never leaves a playable file.
export async function encodeVideo(webmFile, outFile, { startSec, durationSec }) {
  const part = `${outFile}.part`
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', webmFile,
      '-ss', startSec.toFixed(3), '-t', durationSec.toFixed(3),
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0b1020,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-movflags', '+faststart', '-f', 'mp4',
      part,
    ])
    await rename(part, outFile)
  } finally {
    await rm(part, { force: true })
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => reject(new RecorderError(`${cmd} could not start: ${err.code || err.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new RecorderError(`${cmd} exited ${code}: ${stderr.trim().slice(-500)}`))))
  })
}
