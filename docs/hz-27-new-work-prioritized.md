# HZ-27: New work, prioritized

Backlog derived from `hz-27-technical-overview.md`. Every item below maps to
exactly one finding in that doc (no item appears in more than one tier —
checked explicitly, see "Dedup check" at the end). Ordered within each tier
by impact first, then effort.

## Tier 1 — blocks a new user immediately

1. **Write a real "new install" setup guide and `.env.example`.** Today the
   full env-var surface is only discoverable by reading
   `server/src/config.js:1-14` and `farm/config.py` source comments; there is
   no `.env.example`, setup script, or single onboarding doc. *(Overview §1)*
2. **Document the Claude subscription requirement before a new user hits
   it.** `farm/claude_runner.py:30-37` hard-refuses to run with
   `ANTHROPIC_API_KEY` set, requiring an interactively logged-in `claude` CLI
   subscription instead — the opposite of what most new users try first.
   Needs a prominent line in `README.md`/`farm/README.md`, ideally before the
   "Running (local dev)" section. *(Overview §6)*
3. **Ship a project-rules template and wire project creation to it.**
   `farm/rules/projects/fintekkers.md` is the only project-rules file and is
   entirely FinTekkers-specific; `resolve_rules()`
   (`farm/rules.py:72-80`) silently renders nothing for every other project,
   and `POST /api/projects` (`server/src/app.js:881-899`) never creates or
   prompts for one. Add `farm/rules/projects/_example.md` (or a
   `_template.md` the Admin UI can offer to scaffold) so a new project isn't
   silently missing all agent context. *(Overview §5)*
4. **Write a "first deploy target on a bare host" guide, separate from
   "adding a new target."** `infra/host/DEPLOY.md`'s only guidance for a
   second target (`DEPLOY.md:96-111`) assumes the sudoers/nginx/systemd
   scaffolding already exists from steps 1-3 on an already-FinTekkers-shaped
   host. A brand-new host needs a walkthrough that doesn't presuppose
   `shoreward.ai`, `/opt/shoreward`, or an existing webhook. *(Overview §2)*
5. **Change the `FARM_SHARED_SECRET` default so a forgotten env var fails
   loudly instead of silently matching.** Both `server/src/config.js:23` and
   `farm/config.py:9` default to the identical literal `'dev-secret'` — a
   fresh deploy that never sets this still "works," with a publicly-known
   secret gating the farm-completion callback
   (`server/src/app.js:987-993`). Lowest-effort fix: generate/require a
   random or explicitly-set value in production instead of a matching
   literal default. *(Overview §6)*

## Tier 2 — low effort, high value

6. **Fix `cookieIsSecure()` to not silently ship insecure session cookies.**
   `server/src/app.js:96-98` infers the `Secure` cookie flag from whether
   `HORIZON_UI_URL` starts with `https`, and `HORIZON_UI_URL` defaults to
   `http://localhost:5173` (`server/src/config.js:19`). A reverse-proxy TLS
   topology or a simply-unset var in production both silently drop `Secure`.
   Fix: add an explicit `SECURE_COOKIES` override (or infer from
   `NODE_ENV=production` as a safer default) rather than relying solely on
   URL string matching. *(Overview §3)*
7. **Hide (or clearly gate) "Sign in with Google" when it isn't
   configured.** `ui/src/components/LoginPage.jsx:75-77` always renders the
   link; clicking it when unconfigured hits a bare `503` JSON body from
   `server/src/app.js:693-694`. One-line fix: have the login page check a
   `googleConfigured` flag (already computable server-side via
   `googleAuth.configured()`) before rendering the link. *(Overview §3)*
8. **Warn (don't just default) on production use of the demo admin
   credential.** `ADMIN_EMAIL`/`ADMIN_PASSWORD` default to
   `admin@example.com`/`admin` (`server/src/config.js:43-44`) with no
   startup warning if they're still unset outside dev. A log line at boot
   when `NODE_ENV=production` and both are unset would catch this cheaply.
   *(Overview §3)*
9. **Surface "this repo has no test/lint tooling, the guardrail is a
   no-op" in the UI, not just a farm log line.** `farm/checks.py:88-112`
   already logs "no test/lint commands detected... nothing to enforce" when
   a connected repo has none — worth surfacing that status on the repo's row
   in `AdminPage.jsx` (next to the existing sync-status dot) so a new user
   doesn't assume tests are being enforced when they aren't. *(Overview §7)*
10. **Stop defaulting `getRepoUrl()` to FinTekkers' own repo.**
    `server/src/settings.js:28-31` returns the literal
    `https://github.com/FinTekkers/horizon` when nothing is configured — a
    fresh install with no repo connected should return `null`/empty instead
    of another org's repo URL. *(Overview §4)*
11. **Replace the stub `.github/workflows/horizon-deploy.yml` or delete
    it.** It still prints "Simulate deploy... Replace this job with the
    real deployment," which predates the self-deploy webhook path that's
    actually in production use. Either delete it or repoint it at something
    real (e.g. running the root guardrail on every PR) so a new user auditing
    CI isn't misled. *(Overview: "Other observations")*

## Tier 3 — nice to have / longer-term

12. **Support more than one GitHub token, scoped per repo or per owner.**
    `AdminPage.jsx:86` documents today's single-shared-token model
    explicitly; multi-org onboarding needs per-repo/per-owner token storage
    in `server/src/settings.js`. Higher effort — a schema and UI change, not
    a one-liner. *(Overview §4)*
13. **Document (or generate) the AWS load-balancer setup a new production
    deploy target would need.** `infra/aws/fintekkers-lb-snapshot.json` is a
    named, single-tenant snapshot with no accompanying doc on its purpose or
    reuse path. *(Overview §2)*
14. **Add a markdown lint step.** No `.markdownlint*`/`.remarkrc*` config
    exists and no lint step runs in CI today; worth adding given how much of
    the agent pipeline's output is markdown artifacts. Purely a quality-of-life
    addition, not a blocker. *(Overview: "Other observations")*

## Dedup check

Each numbered item above cites exactly one overview section and appears in
exactly one tier. Cross-checked pairwise for near-duplicates before finalizing:
- Items 5 and 6 both touch `server/src/config.js` defaults but address
  different bugs (a shared-secret default vs. a cookie-security default) —
  kept separate, not a duplicate.
- Items 5 and 8 are both "weak default that silently works instead of
  failing loudly," but govern unrelated systems (inter-process farm secret
  vs. the demo login credential) — kept separate, not a duplicate.
- No item's title, file, or fix overlaps another item's beyond this.
