import { readFile } from 'node:fs/promises'
import { RecorderError } from './errors.mjs'

// The personal API token (HZ-179) lives in an env file outside the repo, named
// by HORIZON_RECORDER_ENV. That file is the only source: a HORIZON_TOKEN
// exported in the shell is ignored, so a token can't leak in from a stray
// export. Errors name the path and never echo the file's contents.
export async function readToken(env = process.env) {
  const file = env.HORIZON_RECORDER_ENV
  if (!file) throw new RecorderError('HORIZON_RECORDER_ENV is not set: point it at the env file holding HORIZON_TOKEN=')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new RecorderError(`token file not found: ${file}`)
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?HORIZON_TOKEN\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const token = m[1].replace(/^(['"])(.*)\1$/, '$2')
    if (token) return token
  }
  throw new RecorderError(`no HORIZON_TOKEN= line in token file: ${file}`)
}
