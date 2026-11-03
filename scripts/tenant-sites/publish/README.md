# Publish parvati-site to GitHub Pages

`publish.mjs` (HZ-718) publishes `../parvati-site/` as-is to the public
`ParvatiRealEstate/parvati-site` repo and serves it on GitHub Pages. The owner
and repo are constants: there is no flag to point it anywhere else.

## Run it as the Parvati account

```sh
export PARVATI_GITHUB_TOKEN=...   # the Parvati account's token, never another one
npm --prefix scripts/tenant-sites/publish install          # playwright, for screenshots
node scripts/tenant-sites/publish/publish.mjs --dry-run    # prints the planned writes, writes nothing
node scripts/tenant-sites/publish/publish.mjs              # publishes, verifies, writes the report
```

- The token comes from `PARVATI_GITHUB_TOKEN` only. If it is unset, the
  command exits 1 before any request. Any other token variable is ignored.
- The token needs admin rights on the repo (Pages needs them). It is sent only
  to `api.github.com`, in the `Authorization` header.
- Options: `--dry-run`, `--no-screens`, `--out <dir>` (default `publish/.out/`).
  Exit 0 on success, 1 on any failure, 2 on a bad argument.

## What a run does

1. Reads the owner, the repo, its head tree and its Pages settings (GETs only).
   It stops with no writes if the repo is private, the token lacks admin, Pages
   builds from somewhere other than the default branch's root, or (for a user
   account) the token belongs to a different account.
2. Prints the planned writes, and any remote file the new tree leaves out.
   `--dry-run` stops here.
3. Creates the repo once if it is missing, empty (no `auto_init` or
   template, so GitHub makes no commit of its own). An existing repo is
   reused. An empty repo gets its first file through one contents `PUT`.
4. Uploads the changed blobs, then one tree (no `base_tree`, so it equals the
   folder exactly), one commit on top of the head, and a fast-forward ref
   update with `force: false`. An unchanged folder makes no commit.
5. Turns Pages on from the default branch's root if it is off.
6. Waits up to 10 minutes for Pages to build that commit and serve the
   folder's `index.html` byte for byte.
7. Takes desktop (1280×800) and mobile (390×844) screenshots and writes
   `publish-report.json`: owner, visibility, repo URL, Pages URL, served SHA,
   screenshot paths, and `commits`: each pushed commit's `sha`, `author` and
   `committer`. It holds no login, name, email or token of the token's owner.

## Who the commits are by

Every commit (the first-file `PUT` and each `git/commits` call) sets both
`author` and `committer` to `Parvati Real Estate <site@parvati-realestate.example>`
(`lib/identity.mjs`, HZ-725). It is a constant: never read from `GET /user`,
git config or the environment, so GitHub never falls back to the token
owner's name. A commit call without it is refused before it is sent. If
GitHub's reply shows any other author or committer, the run stops before the
ref update and writes no report.

Nothing is ever deleted, recreated or force-pushed. A file removed from the
folder drops out of the next commit; git history keeps it. A failed run
writes no report; run it again.

The live run for the PR must not use `--no-screens`.

## Tests

`../test/publish.test.mjs` and `../test/publish-guardrails.test.mjs` run in
`npm --prefix scripts/tenant-sites test` against a stub GitHub
(`../test/stub-github.mjs`). They need no install and make no network calls.
