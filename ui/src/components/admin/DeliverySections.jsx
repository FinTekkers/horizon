import { useState } from 'react'
import { dryRunDeployTarget } from '../../api'
import DeployTargetOverrides from '../DeployTargetOverrides'

const RESULT_COLOR = { ok: 'var(--success)', failed: 'var(--danger)', never: 'var(--neutral-badge)' }

const DRY_RUN_ERROR = { 401: 'Gate PIN incorrect', 409: 'Dry run already running' }

// HZ-258: five read-only checks of the stored target (script, repo dir,
// service, sudo, health). Asks for the gate PIN on every run and sends it in
// a header only; the request carries nothing else, so it cannot change what is
// probed. Results live in this component only.
function DeployDryRun({ target }) {
  const [pin, setPin] = useState('')
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!pin || busy) return
    setBusy(true)
    setError(null)
    setResults(null)
    try {
      const result = await dryRunDeployTarget(target.key, pin)
      setResults(result.results || [])
    } catch (err) {
      setError(Object.hasOwn(DRY_RUN_ERROR, err.status ?? '') ? DRY_RUN_ERROR[err.status] : err.message)
    } finally {
      setPin('')
      setBusy(false)
    }
  }

  return (
    <div className="deploy-dry-run">
      <div className="project-block__add">
        <input
          className="field__input"
          type="password"
          autoComplete="off"
          aria-label={`Gate PIN to dry-run ${target.repo}`}
          placeholder="Gate PIN to dry-run"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button type="button" className="composer__submit" style={{ background: 'var(--primary)' }} onClick={run} disabled={!pin || busy}>
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>
      {error && <div className="gh-error">{error}</div>}
      {results && (
        <ol className="deploy-dry-run__list" aria-label={`Dry run results for ${target.repo}`}>
          {results.map((r) => (
            <li key={r.check} className={`deploy-dry-run__item deploy-dry-run__item--${r.pass ? 'pass' : 'fail'}`}>
              <span className="deploy-dry-run__check">{r.check}</span>
              <span className="deploy-dry-run__badge">{r.pass ? 'pass' : 'fail'}</span>
              <span className="deploy-dry-run__reason">{r.reason}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function DeployTargetRow({ target }) {
  const [open, setOpen] = useState(false)
  const lastAt = target.lastAt ? new Date(target.lastAt).toLocaleString() : 'never deployed'
  return (
    <div>
      <div className="deploy-target-row">
        <span className="admin-status__dot" style={{ background: RESULT_COLOR[target.lastResult] || RESULT_COLOR.never }} />
        <span className="deploy-target-row__repo">{target.repo}</span>
        <span className="deploy-target-row__service">{target.service}</span>
        <span className="deploy-target-row__tag">{target.lastTag || 'no deploy yet'}</span>
        <span className="deploy-target-row__result">{target.lastResult} · {lastAt}</span>
      </div>
      <div className="repo-checks">
        <button type="button" className="repo-checks__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Dry run
        </button>
      </div>
      {open && <DeployDryRun target={target} />}
    </div>
  )
}

// Status and Dry run only: this panel renders the deploy_target table's rows
// plus each target's on-disk deploy state, with no create, edit, or delete
// path here. Its one action, Dry run (HZ-258), only reads. Targets are edited
// in Deploy target overrides (HZ-259), PIN-gated and re-validated against
// horizon-deploy.sudoers. AdminPage owns the fetch (HZ-303: the project
// rows read the same targets) and re-reads after each edit, so this list (and
// its Dry run) picks up new targets without a reload.
function DeployTargetsPanel({ targets, error }) {
  return (
    <div className="panel admin__panel">
      <h2 className="panel__title">Deploy targets</h2>
      <div className="panel__subtitle">
        Status and Dry run — stored in the deploy_target table. Edit targets in Deploy target overrides below.
        Dry run checks a target without deploying, restarting or writing anything.
      </div>

      {error && <div className="gh-error">{error}</div>}
      {targets && targets.length === 0 && <div className="gh-note">No deploy targets registered.</div>}
      {targets && targets.map((target) => <DeployTargetRow key={target.key} target={target} />)}
    </div>
  )
}

// HZ-327: "2026-10-07T09:12:00.000Z" -> "2026-10-07 09:12 UTC" — the same in
// every browser locale.
const utcMinute = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—')

const PING_LABELS = { sent: 'sent', failed: 'send failed', skipped: 'not sent (notifications off)', pending: 'sending' }

// HZ-327: the farm reruns a failing check once; a pass on rerun is a flake,
// recorded here instead of costing an attempt. Read-only: nothing is skipped
// or quarantined, so this list is where repeat offenders show up to be fixed.
// AdminPage owns the fetch, like the deploy targets above.
function FlakyTestsPanel({ data, error }) {
  return (
    <div className="panel admin__panel">
      <h2 className="panel__title">Flaky tests</h2>
      <div className="panel__subtitle">
        Tests that failed and then passed on the same code — on the farm&apos;s one rerun, or across runs. The owner
        is pinged once when a test flakes 3 times in 7 days.
      </div>

      {error && <div className="gh-error">{error}</div>}
      {data && data.repos.length === 0 && <div className="gh-note">No flaky tests recorded.</div>}
      {data &&
        data.repos.map(({ repo, tests }) => (
          <div key={repo} style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{repo}</div>
            <div className="data-table-wrap">
              <table className="data-table" aria-label={`Flaky tests in ${repo}`}>
                <thead>
                  <tr>
                    <th align="left">Test</th>
                    <th align="left">Flakes (7 d / total)</th>
                    <th align="left">Last seen</th>
                    <th align="left">Last item</th>
                    <th align="left">Pinged</th>
                  </tr>
                </thead>
                <tbody>
                  {tests.map((t) => (
                    <tr key={t.test}>
                      <td style={{ wordBreak: 'break-word' }}>
                        {t.test}
                        {!t.name_parsed && <span className="gh-note"> (test name not parsed)</span>}
                      </td>
                      <td>{`${t.count_7d} / ${t.count}`}</td>
                      <td>{utcMinute(t.last_seen)}</td>
                      <td>{t.last_item_id || '—'}</td>
                      <td>{t.ping_status ? `${PING_LABELS[t.ping_status] || t.ping_status} ${utcMinute(t.pinged_at)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  )
}

// HZ-564: Delivery › Deploy targets. The overrides stay under the status
// table until they move onto each target with the per-repository pages.
export function DeployTargetsSection({ targets, error, projects, onChanged }) {
  return (
    <>
      <DeployTargetsPanel targets={targets} error={error} />
      <DeployTargetOverrides projects={projects} onChanged={onChanged} />
    </>
  )
}

// HZ-564: Delivery › Flaky tests.
export function FlakyTestsSection({ data, error }) {
  return <FlakyTestsPanel data={data} error={error} />
}
