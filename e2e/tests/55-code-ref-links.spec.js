// HZ-546, end to end: a Plan step's two attempts each recorded the commit of
// every repo they read (step_run.source_shas). From the item page, the step
// card's artifact link opens the full artifact, where the well-formed code
// reference is a GitHub link at the attempt's own sha and the malformed ones
// stay plain code. The earlier attempt's page links at its own sha, and a
// reload changes nothing.
//
// Rows are seeded directly (fixtures/seed.js), so the orchestrator never
// kicks them: the item waits at the Approve the design gate, in its own
// project with its own two connected repos.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertProjectRepo, insertStepRun } from '../fixtures/seed.js'
import { STEPS, kindStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'PL-E2E-REFS'
const REPOS = ['e2e-refs/ui-service', 'e2e-refs/horizon']
const DESIGN = kindStepIndex('Design options & recommendation', 'plan')
const DESIGN_GATE = kindStepIndex('Approve the design', 'plan')
const SHA_1 = '1111111111111111111111111111111111111111'
const SHA_2 = '2222222222222222222222222222222222222222'
const REF = 'ui-service:src/routes/treasuries/+page.server.ts:339-342'
const ARTIFACT = [
  '## Options',
  '',
  `The handler is \`${REF}\`.`,
  '',
  'Not references: `:342-363`, `passthrough.rs:184-197`. Filed under PL-E2E-REFS.',
].join('\n')
const hrefAt = (sha) => `https://github.com/e2e-refs/ui-service/blob/${sha}/src/routes/treasuries/+page.server.ts#L339-L342`

const sqliteAgo = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace('T', ' ').slice(0, 19)

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    const project = insertProject(db, { name: 'E2E code references' })
    insertProjectRepo(db, { projectId: project, repo: REPOS[0], prefix: 'ECR' })
    insertProjectRepo(db, { projectId: project, repo: REPOS[1], prefix: 'ECH' })
    insertItem(db, { id: ID, title: 'E2E fixture — a Plan cites code', kind: 'plan', cursor: DESIGN_GATE, project_id: project })
    for (const [attempt, sha, mins] of [
      [1, SHA_1, 40],
      [2, SHA_2, 20],
    ]) {
      insertStepRun(db, {
        itemId: ID,
        stepIndex: DESIGN,
        attempt,
        agent: STEPS[DESIGN].agent,
        output: `designed, attempt ${attempt}`,
        artifact: ARTIFACT,
        startedAt: sqliteAgo(mins + 5),
        endedAt: sqliteAgo(mins),
        sourceShas: { [REPOS[0]]: sha, [REPOS[1]]: sha },
      })
    }
  } finally {
    db.close()
  }
})

// A connected repo left behind is polled for the rest of the suite.
test.afterAll(() => {
  const db = openDb(DB_PATH)
  try {
    for (const repo of REPOS) db.prepare('DELETE FROM project_repo WHERE repo = ?').run(repo)
  } finally {
    db.close()
  }
})

test('the artifact page links a code reference at each attempt’s own sha, and leaves malformed ones plain', async ({ page }) => {
  await page.goto(`/${ID.toLowerCase()}`)
  const stepCard = page.locator('.step-card').filter({ has: page.locator('.step-card__label', { hasText: STEPS[DESIGN].label }) })
  const artifactLink = stepCard.locator('.step-card__artifact-link')
  await expect(artifactLink).toHaveText('attempt 2 of 2 ↗')

  const [artifact] = await Promise.all([page.waitForEvent('popup'), artifactLink.click()])
  const link = artifact.getByRole('link', { name: REF })
  await expect(link).toHaveAttribute('href', hrefAt(SHA_2))
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  for (const plain of [':342-363', 'passthrough.rs:184-197']) {
    await expect(artifact.locator('article code', { hasText: plain })).toHaveCount(1)
    await expect(artifact.getByRole('link', { name: plain })).toHaveCount(0)
  }
  await expect(artifact.getByRole('link', { name: ID })).toHaveAttribute('href', new RegExp(`/${ID.toLowerCase()}$`))

  await artifact.locator('.attempts a', { hasText: 'attempt 1' }).click()
  await expect(artifact).toHaveURL(new RegExp(`/artifacts/${DESIGN}/1$`))
  await expect(artifact.getByRole('link', { name: REF })).toHaveAttribute('href', hrefAt(SHA_1))

  await artifact.reload()
  await expect(artifact.getByRole('link', { name: REF })).toHaveAttribute('href', hrefAt(SHA_1))
})
