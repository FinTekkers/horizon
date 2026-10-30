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
