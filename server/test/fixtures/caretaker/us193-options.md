## Context from the code

- The form is `src/routes/contactus/+page.svelte`. It POSTs to `?/message` with fields `firstname`, `lastname`, `email` and `message`.
- The handler is `src/routes/contactus/+page.server.ts`. It sends via nodemailer from `$CONTACT_GMAIL_USER` to that same inbox.
- The subject is `New message from {firstname} {lastname}`. Putting the marker in `lastname` puts it in the subject, so no form change is needed.
- `@playwright/test` is already installed. `playwright.config.ts` only covers `tests/e2e/` and needs a localhost login.
- Vitest only collects `src/**` (`vitest.config.js`). Integration tests collect only `src/tests/smoke.test.ts` and similar files (`vitest.integration.config.js`).
- `google-auth-library` is already a dependency. `googleapis` is not.
- The repo has no Gmail **read** credential. The only one is the SMTP app password `$CONTACT_GMAIL_APP_PASSWORD`.

## Options

### A — Playwright prod spec + Gmail REST via `google-auth-library`

- New config `playwright.smoke.config.ts`:
  - `testDir: ./tests/smoke`
  - `baseURL: https://www.fintekkers.org/`
  - `retries: 0` always, `workers: 1`
  - No `setup` dependency
  - Test timeout about 7 min
- New spec `tests/smoke/contact-form-prod.spec.ts`. It fills the form once and asserts the success banner.
- Marker format: `FTSMOKE` + compact UTC timestamp + random hex, all alphanumeric. Gmail search tokenises that reliably.
- Gmail check:
  - `OAuth2Client` from `google-auth-library` refreshes the token.
  - `fetch` calls `gmail/v1/users/me/messages?q=in:inbox subject:<marker>`.
  - It polls every 10s for up to 5 min.
  - It fetches with `format=metadata` only. Bodies are never downloaded.
- New script: `npm run test:smoke:prod` = `playwright test -c playwright.smoke.config.ts`.
- **Pros:** Tests the real browser path, including hydration and the submit button. Adds no new dependencies. Stays out of vitest because the spec is outside `src/`. Stays out of `test:e2e` because it has its own `testDir`.
- **Cons:** The runner needs Chromium (`npx playwright install chromium`). Runs are slower. It depends on the page's success-banner markup.
- **Effort:** about 1 day.

### B — Plain Node script using `fetch` only

- `scripts/smoke/contact-form-prod.mjs` POSTs the form to `/contactus?/message`.
- It sends an `Origin` header to pass SvelteKit's CSRF check. It reads the action JSON result.
- The Gmail check is the same as in A.
- **Pros:** Fastest and simplest. No browser. Easy to run from any host.
- **Cons:** Skips the browser path, so a broken client bundle still passes. It is tied to SvelteKit's action wire format. It has to fake an `Origin` header.
- **Effort:** about 0.5 day.

### C — Vitest smoke tier with its own config

- `vitest.smoke.config.js` with `environment: node`. It includes only `tests/smoke/*.smoke.ts`. Submission uses `fetch`, as in B.
- **Pros:** Matches the repo's existing tier pattern (`vitest.integration.config.js`). Reports in the format the team already reads.
- **Cons:** It has the same browser-path gap as B. The name is easy to confuse with `src/tests/smoke.test.ts`, which is already in the integration tier. Vitest's 5-min timeouts and watch mode make it awkward for a one-shot prod run.
- **Effort:** about 0.5–1 day.

### Gmail access, applies to all options

- **Chosen:** an OAuth refresh token with scope `gmail.readonly`, from `$GMAIL_CLIENT_ID`, `$GMAIL_CLIENT_SECRET` and `$GMAIL_REFRESH_TOKEN`.
- **Rejected:** IMAP with `$CONTACT_GMAIL_APP_PASSWORD`. App passwords give full mailbox access, and IMAP can mark mail as read. That breaks guardrail 3, and IMAP would also need a new dependency.

## Recommendation

**Approve Option A.** Only a browser run proves what a real visitor sees. It meets every metric with existing dependencies.

How A meets each success metric:

1. **Unique marker:** `FTSMOKE<ts><hex>` goes in `lastname`, which puts it in the subject. It also goes in `message`. The form is submitted once per run.
2. **Arrival within 5 min:** the test polls `in:inbox subject:<marker>`. The deadline is 300 s, set by `SMOKE_EMAIL_TIMEOUT_MS`.
3. **Non-zero exit without the email:** the test fails if no message arrives, even when the banner showed success.
   - If the message is found under `in:anywhere` but not in the inbox, the test still fails. Its error says the message arrived but is not in the inbox.
   - Negative check: `SMOKE_SELFTEST_WRONG_MARKER=1` searches for a different marker. That run must fail.
4. **Not collected by other runs:** the spec lives in `tests/smoke/`. Checks:
   - `npx vitest list` does not show it.
   - `npx vitest run` and `npm run test` do not collect it.
   - `npx playwright test --list` (the default config) does not show it.
5. **Credentials from env only:** the env var names are documented in `tests/smoke/README.md` and `.env.example`, with empty values. `git grep` is checked for credential values.
6. **Fail fast:** a preflight check runs before anything is submitted. If a var is missing it throws, for example `Missing env var: GMAIL_REFRESH_TOKEN`. It never skips.

Guardrails:

- `retries: 0` is hard-coded, even when `CI` is set.
- Polling Gmail is read-only and never resubmits the form.
- Logs show only the marker, the message ID and pass or fail.
- No changes to `+page.server.ts`, CI or `infra/host/deploy-ui-service.sh`.

Risk notes for the reviewer:

- **Self-sent mail:** Gmail sometimes files mail sent to yourself under Sent only. If that happens, the run fails with the clear inbox message above. This is reported as a finding, not patched.
- **Real messages:** each run sends one real message into the inbox, which stays there. The test cannot clean it up because access is read-only. The `FTSMOKE` prefix makes these easy to filter by hand.
- **Prettier:** new files must pass `npm run lint`, which includes Prettier.

Prerequisite before implementation (does not block approval):

- `$GMAIL_CLIENT_ID`, `$GMAIL_CLIENT_SECRET` and `$GMAIL_REFRESH_TOKEN` do not exist anywhere in the repo or the deploy secrets. A human must create an OAuth client and a `gmail.readonly` refresh token for the `$CONTACT_GMAIL_USER` inbox.
- Until those exist, the implementer can build the test and check metrics 4–6. Metrics 1–3 need the real credentials.
- The implementer must raise this gap, not guess at a workaround.

## Blockers

None.
