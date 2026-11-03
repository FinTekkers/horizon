import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PublishError, TOKEN_SHAPES } from './errors.mjs'

export const REPORT_FILE = 'publish-report.json'

// The facts the PR needs and nothing about the person behind the token: no
// login, name or email (the account may be named after a founder).
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
    fileCount: facts.fileCount,
    screenshots: facts.screenshots ?? null,
    publishedAt: facts.publishedAt,
  }
}

// Writes <outDir>/publish-report.json. It refuses to write at all if the JSON
// holds one of the secrets or anything token-shaped.
export async function writeReport(outDir, report, secrets = []) {
  const json = JSON.stringify(report, null, 2)
  if (secrets.some((s) => s && json.includes(s)) || TOKEN_SHAPES.some((re) => new RegExp(re.source).test(json))) {
    throw new PublishError('the report holds a token or token-shaped string, so it was not written')
  }
  await mkdir(outDir, { recursive: true })
  const file = path.join(outDir, REPORT_FILE)
  await writeFile(file, `${json}\n`)
  return file
}
