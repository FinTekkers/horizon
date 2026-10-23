import { readFile, readdir, readlink } from 'node:fs/promises'
import { RecorderError } from './errors.mjs'

// The live horizon-server's port. Nothing on it is ever read or contacted.
export const LIVE_PORT = 3001
// Only these two spellings pass. The raw string is matched, before any URL
// parsing, so userinfo (localhost@host), suffixes (localhost.example.com),
// case variants (LOCALHOST) and wildcard DNS (127.0.0.1.nip.io) all fail.
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})(\/[^@\s]*)?$/
// The only environment keys the guard ever keeps from another process.
const KEYS = ['HORIZON_TEST_HOOKS', 'VITE_PROXY_TARGET']

// Refuses any --board that isn't a local throwaway Horizon. It does no
// network I/O: the board's listener is found through /proc and its
// environment is checked for exactly two keys.
//  - the board URL is http://127.0.0.1:<port> or http://localhost:<port>,
//    and the port isn't 3001;
//  - the process listening there (the UI) has a VITE_PROXY_TARGET that is
//    itself a loopback URL on a port other than 3001;
//  - the process listening on that port (the API; it may be the same one)
//    was started with HORIZON_TEST_HOOKS=1.
// Port 3001 is refused before /proc is read, so the live service's state is
// never looked at. Error messages name ports, never environment values.
export async function checkBoard(boardUrl, { procRoot = '/proc' } = {}) {
  const uiPort = loopbackPort(boardUrl, '--board')
  const ui = await envOn(uiPort, procRoot)
  if (ui.VITE_PROXY_TARGET === undefined) refuse(`the process on port ${uiPort} has no VITE_PROXY_TARGET, so the API it talks to can't be checked`)
  const apiPort = loopbackPort(ui.VITE_PROXY_TARGET, `the VITE_PROXY_TARGET of the process on port ${uiPort}`)
  const api = apiPort === uiPort ? ui : await envOn(apiPort, procRoot)
  if (api.HORIZON_TEST_HOOKS !== '1') refuse(`the API on port ${apiPort} was not started with HORIZON_TEST_HOOKS=1`)
  return { uiPort, apiPort }
}

function refuse(reason) {
  throw new RecorderError(`walkthrough refused --board: ${reason}`)
}

function loopbackPort(url, what) {
  const m = typeof url === 'string' ? LOOPBACK_URL.exec(url) : null
  if (!m) refuse(`${what} must be http://127.0.0.1:<port> or http://localhost:<port> (a local throwaway Horizon)`)
  const port = Number(m[2])
  if (port < 1 || port > 65535) refuse(`${what} has no valid port`)
  if (port === LIVE_PORT) refuse(`${what} is on port ${LIVE_PORT}, the live horizon-server`)
  return port
}

// The two kept keys of every process listening on <port>. All of them must
// agree, so a second listener on the same port can't hide behind the first.
async function envOn(port, procRoot) {
  const inodes = await listeningInodes(port, procRoot)
  if (!inodes.size) refuse(`nothing listens on port ${port}`)
  const pids = await pidsHolding(inodes, procRoot)
  if (!pids.length) refuse(`can't find the process listening on port ${port}`)
  let kept = null
  for (const pid of pids) {
    const env = await keptEnv(pid, procRoot, port)
    if (kept && KEYS.some((k) => kept[k] !== env[k])) refuse(`the processes listening on port ${port} disagree`)
    kept = env
  }
  return kept
}

async function listeningInodes(port, procRoot) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set()
  let found = false
  for (const table of ['tcp', 'tcp6']) {
    let text
    try {
      text = await readFile(`${procRoot}/net/${table}`, 'utf8')
    } catch {
      continue
    }
    found = true
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      // local_address is <hex addr>:<hex port>; state 0A is LISTEN.
      if (cols.length > 9 && cols[1].endsWith(`:${hexPort}`) && cols[3] === '0A' && cols[9] !== '0') inodes.add(cols[9])
    }
  }
  if (!found) refuse(`can't read ${procRoot}/net/tcp (the --board check needs Linux /proc)`)
  return inodes
}

async function pidsHolding(inodes, procRoot) {
  const links = new Set([...inodes].map((i) => `socket:[${i}]`))
  const pids = []
  for (const pid of (await readdir(procRoot)).filter((d) => /^\d+$/.test(d))) {
    let fds
    try {
      fds = await readdir(`${procRoot}/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      const link = await readlink(`${procRoot}/${pid}/fd/${fd}`).catch(() => null)
      if (link && links.has(link)) {
        pids.push(pid)
        break
      }
    }
  }
  return pids
}

// environ can hold secrets: only the two KEYS are copied out, the rest of
// the buffer is dropped unread, and nothing from it reaches an error.
async function keptEnv(pid, procRoot, port) {
  let raw
  try {
    raw = await readFile(`${procRoot}/${pid}/environ`, 'latin1')
  } catch {
    refuse(`can't read the environment of the process listening on port ${port}`)
  }
  const kept = Object.create(null)
  for (const entry of raw.split('\0')) {
    for (const key of KEYS) {
      if (entry.startsWith(`${key}=`) && !Object.hasOwn(kept, key)) kept[key] = entry.slice(key.length + 1)
    }
  }
  return kept
}
