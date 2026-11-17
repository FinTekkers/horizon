// HO-879: the one place a repo's and an item's web links are built, per
// backend, and GitHub's token pages. The UI never builds one: GET /api/projects
// sends each repo's `url` and `issueUrlTemplate` (the UI only puts an item's
// number in for {n}) and each project's `tokenPages`.
//
// github builds exactly the strings Horizon has always shown:
//   https://github.com/<repo>  and  https://github.com/<repo>/issues/<n>
// sl fills the host's HORIZON_SL_*_URL_TEMPLATE values (config.js). With none
// set, an sl link is null and the UI shows plain text — never a guessed link.
//
// A leaf like backends/names.js — store.js and settings.js import it, so it
// must never import backends/index.js (which loads github.js and, through it,
// store.js). It sits outside server/src/backends/ because store.js imports
// only backends/names.js from there (HO-870, backend-registry.test.mjs).

import { SL_ISSUE_URL_TEMPLATE, SL_REPO_URL_TEMPLATE } from './config.js'
import { DEFAULT_BACKEND } from './backends/names.js'

export const GITHUB_WEB = 'https://github.com'

// The pages where a user creates a GitHub token for Horizon: fine-grained
// (the connect card pre-fills it) and classic, with the two scopes ticked.
// GitHub-only by design — a tenant connect always uses a GitHub token.
export const GITHUB_TOKEN_PAGES = Object.freeze({
  fineGrained: `${GITHUB_WEB}/settings/personal-access-tokens/new`,
  classic: `${GITHUB_WEB}/settings/tokens/new?scopes=repo,workflow`,
})

// Where an item's number goes in an issueUrlTemplate.
export const ISSUE_NUMBER = '{n}'
const REPO_NAME = '{repo}'

const HOST_SL_TEMPLATES = Object.freeze({ repo: SL_REPO_URL_TEMPLATE, issue: SL_ISSUE_URL_TEMPLATE })

const fill = (template, key, value) => template.split(key).join(value)

// { url, issueUrlTemplate } for `repo` (owner/name) on `backend`. Either is
// null when there is no link to show. `slTemplates` is for tests; callers use
// the host's.
export function repoLinks(backend, repo, slTemplates = HOST_SL_TEMPLATES) {
  if (typeof repo !== 'string' || !repo) return { url: null, issueUrlTemplate: null }
  if (backend === DEFAULT_BACKEND) {
    return { url: `${GITHUB_WEB}/${repo}`, issueUrlTemplate: `${GITHUB_WEB}/${repo}/issues/${ISSUE_NUMBER}` }
  }
  if (backend === 'sl') {
    const issue = slTemplates.issue && slTemplates.issue.includes(ISSUE_NUMBER) ? fill(slTemplates.issue, REPO_NAME, repo) : null
    return { url: slTemplates.repo ? fill(slTemplates.repo, REPO_NAME, repo) : null, issueUrlTemplate: issue }
  }
  return { url: null, issueUrlTemplate: null }
}

// An item's link from its repo's issueUrlTemplate, or null. The UI's
// serverApi.issueUrl does the same substitution.
export function issueLink(issueUrlTemplate, issue) {
  if (typeof issueUrlTemplate !== 'string' || issue == null || issue === '') return null
  return fill(issueUrlTemplate, ISSUE_NUMBER, String(issue))
}
