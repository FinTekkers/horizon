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

// HZ-139 added a second assertion: the emitted JS bundle must CONTAIN a step
// label. domain/js/lifecycle.js now reads its data via a static JSON import
// attribute, and a successful `vite build` does not prove Rollup inlined it —
// it can emit the JSON as a separate asset instead, which then 404s under the
// /horizon/ base. The build stays green, every suite stays green, and the board
// renders empty in production. Grepping the bundle is the cheapest proof the
// data actually shipped.

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { STEPS } from '../../domain/js/lifecycle.js'
import { REASON_IDS } from '../../domain/js/reasons.js'
import { PRIORITIES } from '../../domain/js/priorities.js'

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

// The step data must be IN the bundle, not fetched beside it.
const assetsDir = path.join(DIST, 'assets')
if (!existsSync(assetsDir)) fail('the build produced no ui/dist/assets/')

const jsBundles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
if (jsBundles.length === 0) fail('the build emitted no JS bundle')

// HZ-132 added a SECOND JSON under domain/, reached from ui/src/domain/
// pauseReason.js. It needs its own probe for the same reason the step label
// does: the stray-asset check below is generic, but only a positive grep proves
// the data arrived. Without it, a tree-shake that drops reasons.json leaves
// every pause banner blank in production with npm test still green.
const bundled = jsBundles.map((f) => readFileSync(path.join(assetsDir, f), 'utf8')).join('\n')

// HZ-135 added a THIRD JSON under domain/, reached from
// ui/src/components/NewItemModal.jsx and ui/src/domain/lifecycle.js. It needs a
// probe too — but a single value cannot be the probe here, and that distinction
// is the whole point of this block.
//
// PRIORITIES[0] is "Critical", which ALREADY ships in the bundle via
// ui/src/api/mockApi.js's demo seed rows. Probing for it would pass even if
// domain/priorities.json were deleted outright — a vacuous check that reads like
// a real one. So the probe is the whole ORDERED SEQUENCE, joined: only the
// inlined array can produce those values contiguously and in that order, because
// the seeds mention them one at a time, lines apart, interleaved with titles and
// metrics.
//
// Quotes and whitespace are stripped first so the assertion survives whatever
// Rollup does with quoting and minification. The stray-JSON check further down is
// the other half of the proof: together they say the data is inlined AND not also
// emitted as a fetchable asset.
const squashed = bundled.replace(/["'\s]/g, '')

const PROBES = [
  { value: STEPS[0].label, what: 'the step label', source: 'domain/steps.json', effect: 'the board would render empty' },
  { value: REASON_IDS[0], what: 'the reason id', source: 'domain/reasons.json', effect: 'every pause banner would render blank' },
  {
    value: PRIORITIES.join(','),
    in: squashed,
    what: 'the ordered priority vocabulary',
    source: 'domain/priorities.json',
    effect: 'the intake picker would render no options at all',
  },
]
for (const probe of PROBES) {
  if (!(probe.in ?? bundled).includes(probe.value)) {
    fail(
      `no emitted JS bundle contains ${probe.what} "${probe.value}" — ${probe.source} was not inlined. ` +
        `Rollup emitted it as a separate asset, which 404s under the production base: ${probe.effect}.`,
    )
  }
}

// A stray steps.json, reasons.json or priorities.json beside the bundle means it
// was emitted as a fetchable asset. Harmless only if it is ALSO inlined, which is
// not a state to ship.
const strayJson = readdirSync(assetsDir).filter((f) => f.endsWith('.json'))
if (strayJson.length > 0) {
  fail(`the build emitted JSON asset(s) ${strayJson.join(', ')} — the domain data must be inlined, not fetched`)
}

console.log(
  `verify-base-build: ui/dist/index.html references ${EXPECTED}, and the bundle inlines the step table, the reason vocabulary and the priority vocabulary (${seconds.toFixed(1)}s)`,
)

// A /horizon/-based bundle must not linger: `npm --prefix ui run preview`
// serves dist/ at / locally and would 404 on every asset.
rmSync(DIST, { recursive: true, force: true })
