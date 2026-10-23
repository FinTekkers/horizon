import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// HZ-530: a stand-in for a throwaway Horizon, run as its own process so the
// walkthrough guard has a real /proc/<pid>/environ to read. It serves the
// fixture pages and writes one JSON line per request it gets to stdout.
// Run directly, it is the server; imported, startWalkthroughStub() spawns it.

const SELF = fileURLToPath(import.meta.url)

if (process.argv[1] === SELF) {
  const pages = {
    '/': readFileSync(new URL('./fixtures/walkthrough.html', import.meta.url), 'utf8'),
    '/egress': readFileSync(new URL('./fixtures/egress.html', import.meta.url), 'utf8'),
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub')
    process.stdout.write(`${JSON.stringify({ method: req.method, path: url.pathname })}\n`)
    if (req.method === 'GET' && Object.hasOwn(pages, url.pathname)) res.writeHead(200, { 'content-type': 'text/html' }).end(pages[url.pathname])
    else res.writeHead(404).end()
  })
  server.listen(Number(process.env.STUB_PORT || 0), process.env.STUB_HOST || '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ ready: server.address().port })}\n`)
  })
}

// A free port, so a stub's VITE_PROXY_TARGET can name its own port before it starts.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// Spawns the stub on a free port with exactly env(port) (plus PATH). `log` is
// every request it has served so far. The default env looks like a hooks-on
// Horizon whose UI proxies to itself.
export const HOOKS_ON = (port) => ({ HORIZON_TEST_HOOKS: '1', VITE_PROXY_TARGET: `http://127.0.0.1:${port}` })
export async function startWalkthroughStub({ host = '127.0.0.1', env = HOOKS_ON } = {}) {
  const port = await freePort()
  const stubEnv = env(port)
  const child = spawn(process.execPath, [SELF], {
    env: { PATH: process.env.PATH, STUB_PORT: String(port), STUB_HOST: host, ...stubEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const log = []
  let buf = ''
  await new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`walkthrough stub exited ${code}`)))
    child.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (msg.ready) resolve()
        else log.push(msg)
      }
    })
  })
  // Lets the stub's last log lines arrive before a case reads them.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200))
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    log,
    settle,
    close: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.removeAllListeners('exit')
      child.on('exit', resolve)
      child.kill()
    }),
  }
}
