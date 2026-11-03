import { spawn } from 'node:child_process'
import { chmod, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { RecorderError } from './errors.mjs'

// HZ-698: production mode's saved browser profile. It holds the live Google
// session of the Parvati Real Estate tenant, made once by hand with
// --init-profile. Only a directory holding this marker is ever opened, so the
// owner's own Chrome profile can't be filmed by mistake. Errors never name
// the path: it is a secret's location.
export const PROFILE_MARKER = '.parvati-profile'
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
// Personal browser profiles, relative to $HOME. Never a recorder profile.
const PERSONAL = [
  '.config/google-chrome',
  '.config/google-chrome-beta',
  '.config/chromium',
  'snap/chromium',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Chromium',
]
const MARKER_TEXT = 'HZ-698: the recorder profile of the Parvati Real Estate tenant. It holds a live Google session: never commit, log or upload it.\n'

function refuse(reason) {
  throw new RecorderError(`production refused --profile: ${reason}`)
}

const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`)

// The resolved path of an existing ancestor-or-self, so a path that doesn't
// exist yet is still compared through symlinks.
async function resolveLoose(p) {
  const abs = path.resolve(p)
  try {
    return await realpath(abs)
  } catch {
    const parent = path.dirname(abs)
    return parent === abs ? abs : path.join(await resolveLoose(parent), path.basename(abs))
  }
}

async function refusePlace(real, { repoRoot, home }) {
  if (inside(real, await resolveLoose(repoRoot))) refuse('--profile is inside the repo: keep it outside, e.g. ~/parvati.profile')
  for (const rel of PERSONAL) {
    if (inside(real, await resolveLoose(path.join(home, rel)))) refuse('--profile is a personal browser profile: use the Parvati profile made with --init-profile')
  }
}

// Returns the profile's real path, or throws when it is in the repo, is (or
// is under) a personal Chrome/Chromium profile, isn't a directory, is
// readable by group or others, or has no marker.
export async function checkProfile(dir, { repoRoot = REPO_ROOT, home = homedir() } = {}) {
  if (typeof dir !== 'string' || !dir) refuse('--production needs --profile <dir> (make one with --init-profile)')
  const real = await resolveLoose(dir)
  await refusePlace(real, { repoRoot, home })
  const st = await stat(real).catch(() => null)
  if (!st?.isDirectory()) refuse('--profile is not a directory: make one with --init-profile')
  if (st.mode & 0o077) refuse('--profile is readable by other users: chmod 700 it')
  if (!(await stat(path.join(real, PROFILE_MARKER)).catch(() => null))?.isFile()) refuse(`--profile has no ${PROFILE_MARKER} marker: make it with --init-profile`)
  return real
}

// Makes (or reuses) a profile dir with mode 0700 and the marker, then opens
// plain Chromium on <baseUrl>/horizon/ for the one sign-in by hand. The
// browser gets no automation flags, so Google lets a person sign in, and
// the same password store as Playwright, so the cookies decrypt later.
// Resolves when the owner closes the window. `executablePath` is injectable
// so the tests run without a display.
export async function initProfile(dir, { baseUrl, log, repoRoot = REPO_ROOT, home = homedir(), executablePath = chromium.executablePath() }) {
  if (typeof dir !== 'string' || !dir) refuse('--init-profile needs a directory')
  const real = await resolveLoose(dir)
  await refusePlace(real, { repoRoot, home })
  const existing = await readdir(real).catch((err) => (err.code === 'ENOENT' ? [] : refuse(`can't read it (${err.code})`)))
  const hasMarker = await stat(path.join(real, PROFILE_MARKER)).then(() => true, () => false)
  if (existing.length && !hasMarker) refuse('--init-profile needs a new or empty directory, or one it made before')
  await mkdir(real, { recursive: true, mode: 0o700 })
  await chmod(real, 0o700)
  await writeFile(path.join(real, PROFILE_MARKER), MARKER_TEXT, { mode: 0o600 })
  log(`init-profile: sign in to the Parvati Google account (and enter the gate PIN once), then close the window`)
  const args = [
    `--user-data-dir=${real}`,
    '--password-store=basic',
    '--use-mock-keychain',
    '--no-first-run',
    '--no-default-browser-check',
    `${baseUrl}/horizon/`,
  ]
  const code = await new Promise((resolve, reject) => {
    // Chromium's own output can name the profile path, so it is dropped.
    const child = spawn(executablePath, args, { stdio: 'ignore' })
    child.on('error', (err) => reject(new RecorderError(`init-profile: chromium could not start (${err.code || 'error'})`)))
    child.on('exit', (exitCode) => resolve(exitCode))
  })
  log(`init-profile: browser closed (exit ${code}); the profile is ready for --production`)
}
