// HZ-128 success criterion 10: `npm --prefix ui run build` with the production
// base emits dist/index.html referencing /horizon/assets/.
//
// Why this exists as a gate script rather than a note in a runbook: no real
// `vite build` runs anywhere in the test suite today.
// infra/host/test/deploy.test.sh stubs `npm` on PATH and fakes
// dist/index.html with printf, so its ui-build-verify cases stay green even if
// the real build is broken. The only real grep lives in
// infra/host/deploy-horizon.sh, which runs at deploy time — too late.
//
// That matters specifically for this item: domain/ sits OUTSIDE ui/'s Vite
// root, so a production build is exactly the thing this change could break
// while every stubbed suite and every vitest run stays green.
//
// Runs the literal command criterion 10 names, against ui/dist (gitignored),
// then removes ui/dist so no /horizon/-based bundle is left behind for a local
// `vite preview`. Measured wall clock is recorded in domain/README.md.

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const DIST = path.join(REPO_ROOT, 'ui/dist')
const INDEX_HTML = path.join(DIST, 'index.html')
const EXPECTED = '/horizon/assets/'

function fail(message) {
  console.error(`verify-base-build: ${message}`)
  process.exit(1)
}

rmSync(DIST, { recursive: true, force: true })

const started = process.hrtime.bigint()
const build = spawnSync('npm', ['--prefix', 'ui', 'run', 'build'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, HORIZON_BASE: '/horizon/' },
})
const seconds = Number(process.hrtime.bigint() - started) / 1e9

if (build.error) fail(`could not run npm --prefix ui run build (${build.error.message})`)
if (build.status !== 0) fail(`HORIZON_BASE=/horizon/ npm --prefix ui run build exited ${build.status}`)
if (!existsSync(INDEX_HTML)) fail('the build produced no ui/dist/index.html')

const html = readFileSync(INDEX_HTML, 'utf8')
if (!html.includes(EXPECTED)) {
  fail(
    `ui/dist/index.html does not reference ${EXPECTED} — the production base did not apply. ` +
      'deploy-horizon.sh greps for exactly this, so a deploy would serve a bundle the browser cannot fetch.',
  )
}

console.log(`verify-base-build: ui/dist/index.html references ${EXPECTED} (${seconds.toFixed(1)}s)`)

// A /horizon/-based bundle must not linger: `npm --prefix ui run preview`
// serves dist/ at / locally and would 404 on every asset.
rmSync(DIST, { recursive: true, force: true })
