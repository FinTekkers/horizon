# HZ-27: Extending Horizon to new users — technical overview

Deep-dive review of the codebase, focused on what breaks (or silently does
nothing) when a brand-new user tries to install, deploy, and run Horizon for
their own project — not FinTekkers. This is a documentation-only deliverable:
no source was changed to produce it.

**Method.** Walked the actual new-user journey — fresh clone → local run →
production deploy → first login → connect a project/repo → onboard agent
rules → first work item run — reading the real code and configs at each step
(not a subsystem-by-subsystem sweep), because the interesting gaps in this
codebase are cross-cutting: a hardcoded default in one file only becomes a
problem in combination with a missing doc in another.

**Headline finding.** The core engine (server orchestrator, farm daemon,
role/persona prompts) is already generic — nothing under `farm/roles/`,
`farm/pm_agent.py`, `farm/step_agent.py`, or `server/src/personas.js` is
FinTekkers-specific. The single-tenant assumptions are concentrated in a
predictable, narrow set of places: **hardcoded infra config**
(`infra/host/`), **one hardcoded rules file**
(`farm/rules/projects/fintekkers.md`), **a few weak defaults**
(`server/src/config.js`, `farm/config.py`), and **the near-total absence of
setup tooling/docs** for anyone who isn't the original author. That's good
news: the fixes are additive (docs, templates, a couple of validation
checks), not a rearchitecture.

---

## 1. Fresh clone → local run

The only setup instructions are `README.md:9-24` ("Running the prototype")
and `farm/README.md:7-15`. There is no `.env.example`, no setup script, and
no onboarding wizard anywhere in the repo (confirmed: no file matching
`*.env*`, `setup*`, or `install*` exists outside `node_modules`). Every
environment variable a new user needs is documented only as a source comment
in `server/src/config.js:1-14` and `farm/config.py`. A new user has to read
two source files to discover the full configuration surface — there is no
single doc that lists it.

## 2. Fresh production deploy

`infra/host/DEPLOY.md` is titled "Self-deploy: one-time host setup" but its
entire content assumes a host that is already most of the way to production:
a domain (`shoreward.ai`, `infra/host/nginx-site.conf:12`), an existing
`/opt/shoreward/dist` static site and `/opt/horizon` checkout
(`nginx-site.conf:14,32`), and a webhook already registered on
`FinTekkers/horizon` (`DEPLOY.md:63-66`). `infra/host/deploy-targets.json:1-22`
hardcodes exactly two targets, both FinTekkers repos. The "Adding a new
target" section (`DEPLOY.md:96-111`) is the only documented path for a
second deploy target, and it assumes the sudoers/nginx/systemd scaffolding
from steps 1-3 is already in place — there is no "first deploy target on a
bare host" walkthrough, only "n+1th target on an already-configured host."
`infra/aws/fintekkers-lb-snapshot.json` is a named, single-tenant AWS
load-balancer snapshot with no doc explaining its purpose or whether/how a
new deploy would need an equivalent.

## 3. First login

`server/src/config.js:43-44` hardcodes a dev-mode fallback credential
(`ADMIN_EMAIL`/`ADMIN_PASSWORD` default to `admin@example.com`/`admin`) —
documented as a fallback, but nothing in the code or deploy docs warns or
blocks a production deploy that forgets to override it.

`ui/src/components/LoginPage.jsx:75-77` always renders a "Sign in with
Google" link, regardless of whether Google OAuth is configured. Clicking it
hits `GET /api/auth/google/start` (`server/src/app.js:693-694`), which
returns a bare `503 {"error":"google_sso_not_configured"}` JSON body — on a
fresh install with no Google credentials set, every new user sees what looks
like a broken login button and a raw API error, not a clear "Google sign-in
isn't set up yet" message.

`cookieIsSecure()` (`server/src/app.js:96-98`) sets the session cookie's
`Secure` flag purely by checking whether `HORIZON_UI_URL` starts with
`https`. `HORIZON_UI_URL` defaults to `http://localhost:5173`
(`server/src/config.js:19`) when unset. Two realistic new-deploy scenarios
both silently ship the session cookie without `Secure`: (a) `HORIZON_UI_URL`
is simply never set in production, or (b) the app sits behind a reverse
proxy that terminates TLS upstream while the app's own configured URL is
internal/http. Neither case raises an error or a warning.

## 4. Connecting a project and repo (Admin UI)

The Admin flow itself (`ui/src/components/AdminPage.jsx`) is in reasonably
good shape for a new user — the GitHub token panel
(`AdminPage.jsx:116-155`) walks through fine-grained token creation
step-by-step, and the deploy-targets panel is correctly read-only
(`AdminPage.jsx:188-192`, matching the design intent in `DEPLOY.md:8-17`
that a deploy target is a reviewed-PR-only artifact).

Two real gaps:

- `AdminPage.jsx:86` states plainly: "One token shared by all connected
  repositories." A new org connecting repos that live under two different
  GitHub owners (common when a company's app and infra repos are split
  across orgs) cannot scope tokens per repo — there is no per-repo or
  per-owner token model anywhere in `server/src/settings.js` or the
  `/api/github/token` route.
- `server/src/settings.js:28-31` (`getRepoUrl()`) falls back to the literal
  string `https://github.com/FinTekkers/horizon` when no repo is configured
  yet. On a fresh install with nothing connected, any UI surface that calls
  this before a project exists will point at FinTekkers' own repo.

## 5. Onboarding agent rules for a new project

`farm/rules.py:72-80` (`resolve_rules()`) confirms that per-project rules
are a **designed extension point**: it looks up
`farm/rules/projects/<slugified-project-name>.md` and silently contributes
nothing if the file doesn't exist (`rules.py:73-74`, `_read_capped` at
`rules.py:56-69` — missing files degrade to `""`, by design, "rules must
never dead-letter a run"). That silent-degrade design is exactly what turns
a missing file into an invisible gap for a new user: creating a project via
`POST /api/projects` (`server/src/app.js:881-899`,
`store.createProject`) never creates, prompts for, or even mentions a
matching rules file. `farm/rules/projects/fintekkers.md` is the **only**
project rules file in the repo, and every line of it (`fintekkers.md:6-44`)
is FinTekkers-specific: a Rust/Java/Postgres service topology, Homebrew
paths, specific ports. There is no template, no `projects/_example.md`, and
no UI affordance for authoring one. A second project's agents run with zero
project-level context and no signal that anything is missing — they simply
get whatever the (also generic) role/persona prompts provide.

## 6. Running the farm (real agents)

`farm/claude_runner.py:30-37` (`assert_subscription_auth()`) **refuses to
run if `ANTHROPIC_API_KEY` is set**, requiring instead an interactively
logged-in `claude` CLI subscription on the host. This is a deliberate cost
guardrail (HZ-5, documented in `farm/README.md` and the function's own
docstring), but it is the opposite of what most new users reaching for
programmatic access will try first — setting an API key — and the failure
mode is a `ClaudeError` raised from Python, not a friendly setup-doc
pointer. Nothing in `README.md` or `farm/README.md` mentions this
requirement before a user gets there.

`FARM_SHARED_SECRET` defaults identically to the literal string
`'dev-secret'` on both sides of the Node↔farm boundary
(`server/src/config.js:23` and `farm/config.py:9`). A fresh install that
never sets this env var still "works" end-to-end (both processes agree on
the same default), which is precisely the failure mode that makes it easy to
miss: the shared secret gating `server/src/app.js:987-993`
(`farmAuthorized()`, protecting `/api/farm/steps/*/complete|fail`) is a
publicly-known string unless a new deployer specifically knows to change it
on both processes.

## 7. First work item run

`farm/checks.py:88-112` (`run_checks`) is the guardrail that runs a
connected repo's own tests/lint before any implement-step push is allowed to
proceed. Its own header comment is explicit about the tradeoff: "the
guardrail is 'tests must pass', not 'tests must exist'" (`checks.py:15`) —
confirmed by `detect_check_commands` (`checks.py:42-85`), which returns an
empty command list (and `run_checks` logs "no test/lint commands detected...
nothing to enforce", `checks.py:93-94`) for any repo without a recognizable
`package.json`/`pytest.ini`/`pyproject.toml` test setup. For Horizon's own
repo this is a non-issue: the root `package.json:6` `test` script fans out
to `server`, `ui`, and `infra/host/test/deploy.test.sh` specifically so this
guardrail is never vacuous here. But a **newly connected target repo** with
no test tooling yet gets a guardrail that silently no-ops — a new user who
assumes "the farm enforces tests" will not find out otherwise until they go
looking. `farm/README.md:146-147` already says this plainly ("No linters are
configured anywhere in the repo yet, so the 'linters must pass' guardrail is
currently vacuous") — worth surfacing more prominently for new repos, not
just this one.

## Other observations (lower severity)

- `.github/workflows/horizon-deploy.yml` is a stub ("Simulate deploy... 
  Replace this job with the real deployment") left over from before the
  self-deploy webhook (`infra/host/deploy-horizon.sh`,
  `server/src/deploy.js`) became the real path. Harmless, but a new user
  auditing "what does CI actually do here" will be misled.
- No markdown linter or formatter is configured anywhere in the repo
  (confirmed: no `.markdownlint*`/`.remarkrc*` config file exists, and
  `.github/workflows/horizon-deploy.yml` has no lint step). Not a functional
  gap, but worth naming since planner/architect agents' primary output is
  markdown artifacts.
- Project switching (`POST /api/projects/:id/activate`,
  `server/src/app.js:940-959`) is correctly surfaced in the UI via
  `TopBar`'s `onRequestSwitch` (`ui/src/App.jsx:139`, confirmed wired
  end-to-end) — flagged during this review as a possible gap, then verified
  not to be one. Included here only so a future reviewer doesn't re-open it.

---

## Testing impact of this change

This PR adds two markdown files under `docs/` and touches no source. The
repo's root guardrail (`package.json:6`, the same `npm test` aggregation
`farm/checks.py` would run) is not skipped for this PR — it still executes
in full and is expected to pass trivially, since nothing under `server/`,
`ui/`, or `infra/` changed. There is no markdown lint step in this repo
today (see above), so there is nothing else to run against the new files.

## Citation verification

Every `file:line` reference above was re-checked against this PR's final
diff with:

```
git diff --name-only main...HEAD   # expect only the two docs/hz-27-*.md files
```

followed by re-grepping each cited path/line pair against the working tree
to confirm the quoted text still matches (not a one-time check performed
only while drafting — see the companion PR checklist).
