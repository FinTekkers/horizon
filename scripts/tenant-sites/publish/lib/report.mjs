import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PublishError, TOKEN_SHAPES } from './errors.mjs'
import { IDENTITY_LINE } from './identity.mjs'

export const REPORT_FILE = 'publish-report.json'

// The facts the PR needs and nothing about the person behind the token: no
// login, name or email (the account may be named after a founder). The one
// identity it lists is the fixed business one every commit is written as
// (IDENTITY_LINE), in commits[]: { sha, author, committer } per pushed commit.
export function buildReport(facts) {
  return {
    owner: facts.owner,
    ownerType: facts.ownerType,
    repo: facts.repo,
    visibility: facts.visibility,
    repoUrl: facts.repoUrl,
    pagesUrl: facts.pagesUrl,
    branch: facts.branch,
    servedSha: facts.servedSha,
    created: facts.created,
    committed: facts.committed,
    commits: facts.commits ?? [],
    fileCount: facts.fileCount,
    screenshots: facts.screenshots ?? null,
    publishedAt: facts.publishedAt,
  }
}

// Writes <outDir>/publish-report.json. It refuses to write at all if the JSON
// holds one of the secrets or anything token-shaped, or lists a commit whose
// author or committer is not IDENTITY_LINE.
export async function writeReport(outDir, report, secrets = []) {
  if ((report.commits ?? []).some((c) => c?.author !== IDENTITY_LINE || c?.committer !== IDENTITY_LINE)) {
    throw new PublishError(`the report lists a commit not written as ${IDENTITY_LINE}, so it was not written`)
  }
  const json = JSON.stringify(report, null, 2)
  if (secrets.some((s) => s && json.includes(s)) || TOKEN_SHAPES.some((re) => new RegExp(re.source).test(json))) {
    throw new PublishError('the report holds a token or token-shaped string, so it was not written')
  }
  await mkdir(outDir, { recursive: true })
  const file = path.join(outDir, REPORT_FILE)
  await writeFile(file, `${json}\n`)
  return file
}
