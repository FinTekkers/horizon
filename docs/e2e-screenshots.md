# E2E screenshots — from a test run to the PR and the baseline

Every implement run photographs the UI at 13 points in the e2e journeys, so a
reviewer at the "Accept the code" gate can see what the change looks like, and
what changed visually, without checking out the branch. This doc explains
where those PNGs go and why they **never ride on the code branch**.

## Why not just commit them?

A PNG has no merge strategy. When screenshots were committed with the code, any
two branches that regenerated the same journey's screenshot conflicted, even if
their code didn't (HZ-63). So `e2e/__screenshots__/` is gitignored, and the
pixels travel on their own git refs instead.

## The three refs

| Ref | Holds | Written by | Lifetime |
|---|---|---|---|
| `horizon/<id>` | The item's code. Never screenshots. | `finalize_branch()` in `farm/step_agent.py`, after checks pass | Deleted when the PR merges |
| `e2e-artifacts/<id>` | This item's PNGs, as a single commit with no history | `publish_screenshots()` in `farm/step_agent.py`, force-pushed on every implement run | Deleted when the PR merges or is closed unmerged |
| `e2e-baseline` | The screenshots of the last merged item | `promoteBaseline()` in `server/src/github.js`, called from `mergePr()` | Permanent; moves on every merge |

`<id>` is the lowercased item id, e.g. `e2e-artifacts/hz-143`.

## The pipeline

```mermaid
flowchart LR
    subgraph WT["Item worktree (farm)"]
        A["1 · Checks<br/>e2e run writes<br/>e2e/__screenshots__/*.png"]
        V["verify-screenshots.mjs<br/>all 13 journeys present?"]
    end
    subgraph REFS["Git refs on GitHub"]
        ART["e2e-artifacts/&lt;id&gt;<br/>orphan commit"]
        CODE["horizon/&lt;id&gt;<br/>code only"]
        BASE["e2e-baseline"]
    end
    PR["4 · Pull request<br/>## Screenshots<br/>## Screenshot comparison vs. baseline"]

    A --> V
    V -- "2 · publish (force-push,<br/>temp git index)" --> ART
    V -- "3 · commit: git add -A<br/>(PNGs gitignored)" --> CODE
    CODE -- "opens PR" --> PR
    ART -- "images by URL" --> PR
    BASE -- "pixel diff" --> PR
    ART -- "5 · on merge:<br/>baseline := this sha,<br/>then ref deleted" --> BASE
```

### 1 · Checks: capture and verify

- Each Playwright journey calls `captureScreenshot(page, name)`
  (`e2e/fixtures/test-base.js`), which writes `e2e/__screenshots__/<name>.png`.
  A failed capture only warns; it never fails the test.
- `e2e/package.json`'s `test` script ends with `node verify-screenshots.mjs`,
  which fails the run if any of the 13 names in `EXPECTED_JOURNEYS` is missing.
  Add a name there when you add a journey that captures a screenshot.
- Checks run **before** anything is committed or pushed ("no green, no push").
  A failed check discards the attempt, so nothing below happens.

### 2 · Publish: `publish_screenshots()`

Once checks pass, the farm builds a commit containing only the PNGs, without
touching the working tree or the real index:

1. Point `GIT_INDEX_FILE` at a temporary index.
2. `git hash-object -w` each PNG, then `git update-index --cacheinfo` it into
   the temp index at `e2e/__screenshots__/<name>.png`.
3. `git write-tree` → `git commit-tree` (no parent, so an orphan commit).
4. Force-push that commit to `refs/heads/e2e-artifacts/<id>`.

This is best-effort. A failure is logged and skipped, and the implement step
carries on. The log says `publish_screenshots: pushed N screenshot(s) to …`,
or `no screenshots to publish — skipped` for items whose runs produce none.

### 3 · Commit: `finalize_branch()`

`git add -A`, commit, `git push --force-with-lease` to `horizon/<id>`. Because
`e2e/__screenshots__/` is in `.gitignore`, the PNGs stay out of the commit,
**as long as none of them is already tracked** (see
[the pitfall below](#pitfall-a-tracked-screenshot-defeats-gitignore)).

### 4 · Review: the PR description

`createPrFromBranch()` reads the artifacts ref, never the code branch, and
adds two sections to the PR body:

- **`## Screenshots`**: one image per PNG, linked by the GitHub contents API's
  `download_url` for `e2e-artifacts/<id>`. The URL names the ref, not a sha,
  so a later implement run's force-push updates the images in place without
  editing the PR.
- **`## Screenshot comparison vs. baseline`**: a table comparing each PNG
  with the same name on `e2e-baseline`, using `pixelmatch` with a per-pixel
  `threshold` of 0.1. A screenshot counts as **changed** only if more than 1%
  of its pixels differ (`DIFF_RATIO_TOLERANCE = 0.01`), which absorbs
  anti-aliasing noise. With no baseline yet (the repo's first merge), the table
  is omitted. The table is computed once, when the PR is opened.

Both are "never throw": a 404 or GitHub hiccup just drops the section.

### 5 · Merge: `promoteBaseline()`

When the "Accept the code" gate merges the PR (squash), `mergePr()`:

1. Deletes `horizon/<id>`.
2. Moves `e2e-baseline` to the sha of `e2e-artifacts/<id>` (`PATCH` with
   `force: true`; creates the ref on the repo's first merge). This is a plain
   overwrite, not read-modify-write, so two merges landing close together are
   safe: last writer wins, and either value is a real merged UI.
3. Deletes `e2e-artifacts/<id>`.

All three steps are best-effort. If promotion fails, the baseline stays one
merge behind until the next merge. The baseline only ever moves on merge,
never from a PR branch.

If the PR is **closed unmerged** on GitHub, the item is sent back and
`e2e-artifacts/<id>` is deleted. The next implement attempt republishes it.

## Repos with `.horizon/screenshots.json`: the farm's capture runner (HZ-506)

A repo can instead commit a screenshot config (`.horizon/screenshots.json`,
schema in `farm/screenshots_config.py`, HZ-505). It commits **no capture
code**: one Horizon-owned runner, `farm/screenshot_runner.py` plus the
Playwright worker in `farm/capture/`, captures every repo's screens. It is
versioned with the config schema (the manifest's `runner` field names the
schema version) and is never copied into a repo.

At the implement step, after every check command passes, `run_checks()` (in
the same check slot) runs it:

1. Starts `serve` with bash, in its own process group.
2. Polls `ready` until it answers. `ready` must be an `http://` URL on
   `127.0.0.1` or `localhost`; its origin is the base for every screen's
   `path`.
3. Captures each shot (screen × viewport × theme) under **that shot's own**
   `timeoutMs`. An overrun kills the worker, marks the shot `timeout`, and
   the next shot gets a fresh worker. A page taller than `maxHeightPx` is cut
   at that height and marked `clipped`. Shots that would start after the
   run's budget (`FARM_CHECK_TIMEOUT_S`) are `skipped`.
4. Writes `<outputDir>/manifest.json`:

   ```json
   {"version": 1, "runner": "farm/screenshot_runner.py@schema-1", "shots": [
     {"screen": "home", "viewport": "desktop", "theme": "light", "status": "ok",
      "durationMs": 812, "png": "home--desktop--light.png", "clipped": false}
   ]}
   ```

   `status` is `ok`, `timeout`, `error` or `skipped`. `png` is relative to
   `outputDir` and `null` unless the shot is `ok`. An `error` entry carries a
   redacted `error` message.
5. Stops `serve`'s whole process group (SIGTERM, then SIGKILL after 5 s) and
   the worker, however the run ended.

A slow or failing shot does **not** fail the check; the summary says e.g.
`screenshots: 5 ok, 1 timeout`. The slot fails only when nothing can be
captured: `outputDir` is not gitignored (no PNG may reach `main`), the worker
or Chromium is not installed, or `serve` never became ready. The slot's saved
command lines in Admin never run — a repo can not swap in its own runner.

`publish_screenshots()` then pushes the PNGs **and `manifest.json`** from the
configured `outputDir`, under the same `e2e/__screenshots__/` tree path on
`e2e-artifacts/<id>`. `server/src/github.js` lists `.png` files only, so the
manifest rides along without showing in the PR. Repos without a config keep
publishing from `e2e/__screenshots__` until the HZ-511 cutover.

**Login.** Captures never log in: only each screen's `path` is visited. The
key mechanism is HZ-494 (PR #498): the repo's `test_env_file` values. A
`login: true` shot sends each value as a request header named
`X-Horizon-Test-Env-<NAME>` (`_` becomes `-`), to the app's own origin only;
a `login: false` shot sends none. `serve` gets the values in its env when any
shot is `login: true`, so the app can check the header it receives. Every
value is redacted from the log, the manifest and the check output.

**Host setup.** `farm/run.sh` runs `npm ci` in `farm/capture` when its
`node_modules` is missing or older than its lockfile. `farm/capture` pins
`playwright` to the exact version `e2e/package-lock.json` resolves, so both
share one Chromium build in `~/.cache/ms-playwright` — bump them together.

## Pitfall: a tracked screenshot defeats `.gitignore`

`.gitignore` only affects untracked files. If a PNG under
`e2e/__screenshots__/` was committed before the ignore rule existed (or
force-added), git keeps tracking it, and every e2e run's regenerated copy shows
up as a modification that `git add -A` commits.

That's what trapped HZ-143. Three stale PNGs (`abandon`, `artifact-history`,
`queued-work`) were still tracked on `main`, which caused this loop:

```mermaid
flowchart LR
    R["e2e run regenerates<br/>queued-work.png"] --> C["git add -A<br/>commits it"]
    C --> X["review rejects<br/>'unrelated binary'"]
    X --> U["agent reverts it<br/>(one review cycle used)"]
    U -- "next attempt" --> R
```

No agent can exit this loop, because the check step regenerates the file on
every attempt. PR #149 fixed it with `git rm --cached` on the three files.

**How to check:** `git ls-files e2e/__screenshots__` must print nothing. If it
prints anything, untrack those files the same way.

## Where to look

| What | File |
|---|---|
| Capture helper | `e2e/fixtures/test-base.js` (`captureScreenshot`) |
| Presence check | `e2e/verify-screenshots.mjs` (`EXPECTED_JOURNEYS`) |
| Ignore rule | `.gitignore` (`e2e/__screenshots__/`) |
| Publish + commit order | `farm/step_agent.py` (`publish_screenshots`, `finalize_branch`) |
| Config-driven capture (HZ-506) | `farm/screenshot_runner.py`, `farm/capture/worker.mjs`, `farm/checks.py` (`_capture_screenshots`) |
| PR body, diff, promotion, cleanup | `server/src/github.js` (`screenshotsMarkdown`, `compareScreenshotsMarkdown`, `createPrFromBranch`, `promoteBaseline`, `mergePr`) |
