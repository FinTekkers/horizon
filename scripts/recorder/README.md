# Recording the walkthrough chapters

`node scripts/record-item.mjs --walkthrough <name>` plays
`scripts/recorder/walkthroughs/<name>.json` against a local throwaway Horizon
and films it to an MP4 (HZ-530). This page covers the Shoreward video's
chapters 1 and 2 (HZ-665). `node scripts/record-item.mjs --help` lists every
flag.

## Prerequisites

```sh
npm --prefix scripts/recorder ci
npx --prefix scripts/recorder playwright install chromium
```

You also need `ffmpeg`, `ffprobe`, `curl` and `openssl` on the PATH.

## The throwaway board

`scripts/recorder/serve-walkthrough.sh` starts the board the scenarios target:

- a demo-mode server (no GitHub, no farm, no messages) on a fresh `mktemp` DB
  that is deleted when the script stops. It never touches
  `server/data/horizon.db` or the live host's DB;
- an empty board: the built-in demo items are removed once the server is up;
- the UI on `http://127.0.0.1:5490`, its API on `5491` (set
  `WALKTHROUGH_UI_PORT` / `WALKTHROUGH_SERVER_PORT` to move them). A busy port
  is an error; the script never stops what holds it;
- `HORIZON_TEST_HOOKS=1`, so the recorder logs in with the
  `SCREENSHOT_LOGIN_KEY` header. That login is the admin user, but never a
  session, so it cannot pass a gate.

It takes no lock and stays off `e2e/screenshots/serve.sh`'s ports, so farm
screenshot captures run alongside it.

## Recording chapters 1 and 2

1. In terminal A, export a fresh random key (never the host's provisioned
   one), and start the board. Wait for `walkthrough board ready`.

   ```sh
   export SCREENSHOT_LOGIN_KEY=$(openssl rand -hex 16)
   scripts/recorder/serve-walkthrough.sh
   ```

2. In terminal B, export the **same** key, then record chapter 1, then
   chapter 2. `--board` is required.

   ```sh
   export SCREENSHOT_LOGIN_KEY=<the key from terminal A>
   node scripts/record-item.mjs --walkthrough setup --board http://127.0.0.1:5490
   node scripts/record-item.mjs --walkthrough create-work --board http://127.0.0.1:5490
   ```

   Each run writes `recordings/walkthrough-<name>/<name>.mp4` and exits 0.
   Without the key, or with the wrong one, it exits 1 with
   `the board showed the login screen`.

3. Check each length:

   ```sh
   ffprobe -v error -show_entries format=duration -of csv=p=0 recordings/walkthrough-setup/setup.mp4
   ffprobe -v error -show_entries format=duration -of csv=p=0 recordings/walkthrough-create-work/create-work.mp4
   ```

4. Stop the board with Ctrl-C in terminal A. Its DB is deleted.

To re-record, restart the board first so it is empty again. Run `setup` before
`create-work`: the new-item form doesn't need a project, but chapter 2's
form then shows the Shoreward project chapter 1 made, as the story needs.
Running `setup` twice on one board films "A project with that name already
exists" under the form, so restart instead.

Record on an idle host: the scenarios wait at most 10 s for each screen.

## What each chapter shows

| Chapter | Scenario | First screen | Last screen |
| --- | --- | --- | --- |
| 1. Setting up Horizon | `setup.json` | Caption card, then the empty board ("No work items yet.") | Admin's Projects panel showing the new Shoreward project |
| 2. Creating work | `create-work.json` | Caption card, then the board | The new item's page, with its Plan phase under way |

Chapter 1 stops at project creation: connecting a repo needs GitHub, and the
throwaway board runs offline. Chapter 2 types a title, outcome and success
metric into the new-item form, creates the item and opens it.

PIN and email fields, and any email address on screen, are masked in every
frame. Scenario files hold no address and never fill a login or PIN field
(`scripts/recorder/test/scenarios.test.mjs` checks both).

# Recording on production (HZ-698)

`node scripts/record-item.mjs --production https://shoreward.ai` films the
Shoreward video's Chapter A, B and C scenes on the real site, signed in as
the **Parvati Real Estate** tenant. Each scene is one file in
`scripts/recorder/walkthroughs/shoreward/` (`A1.json` … `C7.json`) and
becomes one real-time 1920×1080 `<out>/<scene>.mp4`. Every run also appends a
timestamped line per step to `<out>/run.log`. `--out` defaults to
`recordings/shoreward-<YYYYMMDD-HHMMSS>/`, which is gitignored.

Production takes are filmed **unmasked**: the recorder's mask, running inside
Stripe's checkout frame, made Checkout refuse the promo code (A3). The tenant
email, promo code, GitHub token (A7) and gate PIN are blurred in the edit, so
keep the raw MP4s on the box and never share them as they are.

Production mode starts no server and runs no build, so it never touches
`ui/dist`. It sends no test-login header and never reads
`SCREENSHOT_LOGIN_KEY`. The only base URLs it accepts are
`https://shoreward.ai` and loopback URLs for local tests (never port 3001).

## The saved profile

Google blocks scripted sign-ins, so the owner signs in **once, by hand**, in
a saved Chromium profile, and every scene reuses that session. The profile
holds a live Google session:

- keep it **outside the repo**, e.g. `~/parvati.profile`. The recorder
  refuses a path inside the repo, a personal Chrome or Chromium profile
  (`~/.config/google-chrome` and the like), a directory others can read, and
  any directory without the `.parvati-profile` marker that `--init-profile`
  writes. `*.profile/` is gitignored as a second layer;
- never commit, copy, upload or log it. The recorder never prints its path;
- only ever sign in to **Parvati's** Google account in it, never the owner's
  own.

### Making it

`--init-profile` makes the directory (mode 700), writes the marker and opens
plain Chromium (the same binary the recorder uses, with no automation flags
and no sandbox) on `https://shoreward.ai/horizon/`. It needs a **visible window**, and the
EC2 host has no display. Use one of these:

- **On the host, through a virtual display and VNC** (recommended: the
  profile is made where it is used). Install `xvfb` and `x11vnc` once, then:

  ```sh
  Xvfb :99 -screen 0 1920x1080x24 &
  x11vnc -display :99 -localhost -nopw &   # reach it over: ssh -L 5900:localhost:5900 <host>
  DISPLAY=:99 node scripts/record-item.mjs --init-profile ~/parvati.profile
  ```

- **On a Linux desktop**, then copy the directory to the host with
  `rsync -a` (keep it mode 700). Both use `--password-store=basic`, so the
  cookies decrypt on the host. **A profile made on macOS (or Windows) will not
  work on the Linux host**: its cookies are encrypted with that machine's
  keychain.

The window shows Chromium's "You are using an
unsupported command-line flag: --no-sandbox" notice. The flag is there
because AppArmor on the Horizon box blocks Chromium's sandbox ("No usable sandbox!"), so without it
Chromium exits at once. The filming runs go without the sandbox too
(Playwright's default). The notice is harmless: close it or leave it.

In the window: open a new tab, sign in at `accounts.google.com` to the
Google account used for Parvati, then close the window. (Horizon itself only
lets Parvati sign in after payment, which Chapter A films.) Once Chapter A has
made the tenant, run `--init-profile` again on the same directory and, signed
in to Horizon, approve one gate by hand: the gate PIN prompt saves the PIN in
the profile, so Chapter B and C's approvals don't ask for it. The recorder
never types a PIN.

If Google later asks to sign in again, the scene fails with `Google asked
for a sign-in` and you run `--init-profile` again.

## Recording

1. Load the secrets into this shell. `SHOREWARD_PROMO_CODE` (A3) and
   `SHOREWARD_TENANT_EMAIL` (A2, A3's sign-up form) live in the root-only
   `/etc/horizon/recorder.env`. The recorder reads only the environment,
   never that file:

   ```sh
   set -a; source <(sudo cat /etc/horizon/recorder.env); set +a
   ```

2. Record one scene, a list or a whole chapter:

   ```sh
   node scripts/record-item.mjs --production https://shoreward.ai --profile ~/parvati.profile --scene A1
   node scripts/record-item.mjs --production https://shoreward.ai --profile ~/parvati.profile --chapter A
   ```

   A chapter runs its scenes in order, one browser launch each, and stops at
   the first failure (later scenes build on earlier ones). Exit 0 means every
   MP4 was written. A failed scene leaves no MP4 and logs
   `scene <id> FAILED: <reason>` to `run.log` and stderr.

3. Check each video:

   ```sh
   ffprobe -v error -show_entries stream=width,height:format=duration -of default=nw=1 <out>/A1.mp4
   ```

   It should say `width=1920`, `height=1080`, and a duration close to the
   `scene A1 ok <ms> ms` line in `run.log`.

If Google re-asks for a sign-in in the headless browser even with a fresh
profile, record headed on the virtual display: add `--headed` and run under
`xvfb-run -s '-screen 0 1920x1080x24'`.

## The scenes

| Scene | Shows | Needs |
| --- | --- | --- |
| A1 | The shoreward.ai homepage | |
| A2 | Get access: the sign-up form, then the checkout | `SHOREWARD_TENANT_EMAIL` |
| A3 | Paying with the promotion code (setup refills the form off camera) | both variables |
| A4 | The welcome page | runs right after A3 in the same run (`resume`) |
| A5 | Google sign-in: clicks the saved account in Google's chooser | the saved profile |
| A6 | "Set up your first project": names the project Parvati Real Estate | |
| A7 | Connecting the repo on the "Connect your repository" card (HZ-703), then setting the Test command to `npm test` and returning to the board | `PARVATI_GITHUB_TOKEN`; `parvati-site` already published |
| B1–B7 | The first item, "Add a Neighbourhoods page": set the goal, plan (B2 ends on the plan), approve the plan, execute, test and review (B5 ends on the review), approve the change, then the live site's new page | the item from B1; `parvati-site` marked **No deploy** (below) |
| C1–C7 | The first Task, "Find comparable sales for an Upper West Side co-op": define, approve & prioritize, assess and run plan (C3 ends on the run plan), approve the run, execute, verify & report (C6 ends on the 20 ranked sales), review & close | the task from C1 |

Chapter A is a **real sign-up**. A2–A5 create the Parvati tenant once; a
re-take of A3–A5 needs a fresh tenant or an owner reset. A3 and A4 must run
in one invocation (`--chapter A`, or `--scene A3,A4`): A4 reopens the page A3
ended on, which is held in memory only and never logged.

**Before Chapter B**, the owner marks `ParvatiRealEstate/parvati-site` as **No deploy** in Admin › Projects. GitHub Pages publishes the site from `main` by itself, and Horizon refuses the Deploy step for a repo with neither a deploy target nor that mark; with it, Deploy completes at once and the item moves to Review the work & close.

Each B and C scene after the first opens its item from the board in
unfilmed `setup` steps, so each can be re-run on its own. The long scenes
(B2, B4, B5, B7, C3, C5, C6) use `waitUntil`, which keeps filming for up to
2 hours, reloads the page every minute and logs `still waiting …` each
minute. A scene that may wait over 30 minutes needs 5 GB free in the temp
dir and in `--out`.

**First take checks the selectors.** A1–A5 drive the shoreward.ai homepage
(its code is in `FinTekkers/shoreward`), Stripe's embedded checkout and
Google, so their selectors are best guesses until the first headed take. A7 uses
the tenant's connect card; the token is scrubbed from the log. B7 opens the tenant's live site with `gotoSite` and clicks the header's new Neighbourhoods link; GitHub Pages republishes it a minute or so after the merge, so B7 waits up to 15 minutes, reloading. Fixes are JSON-only.

## Scenario actions

Besides `goto`, `click`, `type`, `waitFor`, `pause` and `caption`:

- `waitUntil` `{ selector, timeoutMs (≤ 4 h), reloadEveryMs? (≥ 30 s) }`: a
  long real wait. `waitFor` is for a screen a click away (10 s by default);
  `waitUntil` is for gates, runs and deploys.
- `typeEnv` `{ selector, env, delayMs }`: types an allowlisted environment
  variable (`SHOREWARD_PROMO_CODE`, `SHOREWARD_TENANT_EMAIL`, `PARVATI_GITHUB_TOKEN` for A7's connect card). The field is
  scrubbed from the log. A scene whose variable is unset fails before a
  browser starts.
- `resume` `{}`: opens the page the previous scene of the same run ended on.
- `followLink` `{ selector }`: opens the link's href in the filmed tab, same origin only. "View full artifact ↗" links open a new tab, which is never filmed, so B2, B5, C3 and C6 use this to show the plan, the review, the run plan and the report.
- `gotoSite` `{ url }`: opens a page of the tenant's live site, under `SITE_URL_PREFIXES` in `walkthrough.mjs` only (B7).
- A top-level `setup` list plays before filming starts.

`scripts/recorder/test/scenarios.test.mjs` checks every scene file: no
address, no literal code, and no sign-in step (no typing into a password,
identifier, login, PIN or one-time-code field, no literal into an email
field, no goto to a sign-in path; clicks are allowed).
