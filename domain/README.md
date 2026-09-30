# `domain/` — the lifecycle model, the failure-reason vocabulary, the work-item field limits and the priority vocabulary

**One JSON is the source of truth. Bindings read it. Consumers import from
here.**

Ask "what is a lifecycle step?" — or, since HZ-132, "what can make a step
fail, and will Horizon retry it?", or, since HZ-134, "how long may a work-item
field be?", or, since HZ-135, "what priority may a work item carry, and in what
order?" — and the answer is this directory, by
definition. Before HZ-128 the answer was spread across `server/src/lifecycle.js`,
`ui/src/domain/lifecycle.js`, `farm/steps.py`, two committed
`steps_generated.json` files and a build script living inside one consumer —
with the derived logic hand-copied between server and UI, already diverged
(`requiredStepIndex(label, steps)` vs `requiredIndex(steps, label)`).

## Editing

There is nothing to run. Both bindings are ordinary hand-written source that
read `domain/steps.json` directly, so an IDE can format, lint, type-check and
navigate them like any other file.

- **Changing the model** — a step's budget, its lane, its required inputs, a new
  step — means editing **`domain/steps.json` only**. Both bindings pick it up at
  their next import. It stays the only place a step is declared.
- **Changing the failure vocabulary** — a new reason, or flipping whether an
  existing one is auto-retried — means editing **`domain/reasons.json` only**.
  `AUTO_RETRY_REASONS` is derived from the `retryable` flag, in one line, so
  there is no second list to keep in step. A new reason does need one more edit
  outside `domain/`: its banner copy in `ui/src/domain/pauseReason.js`. That is
  deliberate — copy is presentation — and
  `ui/src/domain/pauseReason.test.js` fails if you forget it.
- **Changing a work-item field's length limit** — or adding a field that carries
  one — means editing **`domain/fields.json` only**. The API's `POST /api/items`
  body schema, the PM agent's `PATCH_FIELDS`, the PM role prompt's field-limit
  line and `measure_text_caps.py`'s report all derive from it. Before HZ-134 those
  were four independent copies of the same three numbers, and they had already
  drifted: the API accepted a `guardrails` value five times longer than a PM
  revision could write.
- **Changing the priority vocabulary** — a new value, a different order, a
  different default — means editing **`domain/priorities.json` only**. The API's
  two enums, the `work_item` `CHECK` constraint, the GitHub label pattern, the
  intake picker and the WhatsApp wizard's numbered prompt all derive from it.
  Before HZ-135 those were ten independent copies across three layers, and two of
  them (a label-matching regex in `server/src/store.js` and another in
  `server/src/github.js`) were byte-for-byte identical.

  **Order is part of the declaration.** The array order is severity, highest
  first, and it is *display* order: the intake picker renders it left to right and
  the wizard numbers it `1) … 2) …`. Nothing in the repo sorts work items by
  priority, so there are deliberately no rank integers.

  A new value does need **three** more edits outside `domain/`, all of them
  presentation or integration, and all of them enforced rather than remembered:
  its label colour in `server/src/github.js`, its theme token in
  `ui/src/domain/lifecycle.js`, and the prose list in `farm/roles/concierge.md`
  (an LLM prompt, so it is pinned rather than rewritten).
  `domain-priority-pins.test.mjs` fails on all three if you forget.

- **Adding or changing a *helper*** means editing `js/lifecycle.js` or
  `py/steps.py` **directly**. Edit the binding you mean; there is no indirection
  between you and it.

If a helper is meant to behave the same in both languages, add a case to
`fixtures/lifecycle-cases.json` (or `fixtures/fields-cases.json`) in the same
change. The suites on both sides fail if an export has no case, so this is
enforced rather than remembered.

## Layout

| Path | What it is |
| --- | --- |
| `steps.json` | The only place a step is declared |
| `steps.schema.json` | The contract `steps.json` must satisfy |
| `reasons.json` | The only place a failure reason is declared |
| `reasons.schema.json` | The contract `reasons.json` must satisfy |
| `validate.mjs` | Dependency-free JSON Schema (Draft-07 subset) validator, used by the test suite |
| `js/lifecycle.js` | The JS binding: imports `steps.json`, exposes the authored table + derived helpers |
| `py/steps.py` | The Python binding: loads `steps.json`, exposes the farm-shaped table + accessors |
| `js/reasons.js` | The JS binding: imports `reasons.json`, exposes the vocabulary + the derived `AUTO_RETRY_REASONS` |
| `py/reasons.py` | The Python binding: loads `reasons.json`, exposes the same vocabulary to the farm |
| `fields.json` | The only place a work-item field's length limit is declared |
| `fields.schema.json` | The contract `fields.json` must satisfy |
| `js/fields.js` | The JS binding: imports `fields.json`, exposes the table + the derived `intakeFields` / `patchLimits` |
| `py/fields.py` | The Python binding: loads `fields.json`, exposes the same table and `patch_limits` to the farm |
| `priorities.json` | The only place a work-item priority, and the order of them, is declared |
| `priorities.schema.json` | The contract `priorities.json` must satisfy |
| `js/priorities.js` | The JS binding: imports `priorities.json`, exposes `PRIORITIES`, `DEFAULT_PRIORITY` and the derived `PRIORITY` constants |
| `py/priorities.py` | The Python binding: loads `priorities.json`, exposes the same vocabulary plus the wizard's derived numbering |
| `fixtures/lifecycle-cases.json` | Input/expected pairs asserted by **both** language suites |
| `fixtures/fields-cases.json` | The same, for the field bindings |
| `fixtures/priorities-cases.json` | The same, for the priority bindings |

Every file here is authored. Nothing is output.

The four sources are **siblings, not one document**. `steps.json` answers "what
is a lifecycle step" and nothing else; a retry policy living inside a file
titled *step table* is the kind of thing nobody finds by grepping, and so is a
field limit, and so is a priority. They share
the validator, the load-time-validation pattern and every guard, and share no
data.

### How each binding reads the source

```js
// js/lifecycle.js
import data from '../steps.json' with { type: 'json' }
```

A **static** import attribute, not a runtime fetch. Node 22 and Rollup both
resolve and inline it at build time, so the UI still works with no server and no
network. `ui/scripts/verify-base-build.mjs` asserts the built bundle really does
carry a step label, which is the difference between "the build succeeded" and
"the data arrived."

```python
# py/steps.py
_SOURCE_PATH = Path(__file__).resolve().parent.parent / "steps.json"
```

`js/reasons.js`/`py/reasons.py`, `js/fields.js`/`py/fields.py` and
`js/priorities.js`/`py/priorities.py` read their own
source exactly the same two ways. `ui/scripts/verify-base-build.mjs` probes the built bundle for a
step label, a reason id **and** the priority vocabulary, because a tree-shake that drops one says nothing
about the others.

The priority probe is shaped differently from the other two, and the difference is
worth knowing before copying it. `PRIORITIES[0]` is `"Critical"`, which already
ships in the bundle via `ui/src/api/mockApi.js`'s demo seed rows — so probing for
a single value would pass even if `priorities.json` were deleted outright. The
probe is the whole **ordered sequence**, joined, against a quote- and
whitespace-stripped bundle: only the inlined array can produce those values
contiguously and in that order.

Derived from `__file__`, never from the process's working directory — farm
agents run inside workspace clones, not from the repo root.
`farm/tests/test_domain_import.py` asserts that with a `chdir`.

### Validation happens at load time

Each binding validates the document as it imports it — shape, `kind`, integer
`phase`, non-empty labels, **unique labels**, and **`phase` in range of
`phases`**. A broken `steps.json` fails at import, in both languages, rather
than reaching a caller. The two implementations
(`assertLifecycleShape` in JS, `_validate_source` in Python) are kept in step by
`fixtures/lifecycle-cases.json`, which drives the same thirteen cases through
both.

`reasons.json` gets the same treatment, with four rules its schema subset
cannot express: an id matching `^[a-z][a-z0-9_]*$`, unique ids, a strictly
boolean `retryable`, and at least one retryable reason. The id-shape rule is
**load-bearing, not cosmetic** — `REASON`'s keys are derived by upper-casing the
id, so a hyphenated id would produce a key no caller can name and a mixed-case
one would collide with its own lower-case form.

`priorities.json` gets it too, with three rules its schema subset cannot express:
each value matching `^[A-Z][A-Za-z]*$`, uniqueness **ignoring case**, and
`default` being a member of `priorities`. None is cosmetic. The value shape is
**load-bearing** because `server/src/db.js` interpolates these values into the
`work_item` `CHECK` constraint — it is what makes that emitted SQL provably safe
rather than safe-by-convention — and because `PRIORITY`'s keys are derived by
upper-casing. The case-insensitive rule exists because the GitHub label match is
case-insensitive, so two values differing only in case would make
`priorityFromLabels` resolve to whichever came first.
`server/test/domain-priorities-schema.test.mjs` asserts the split is real: it
drives the schema over all three and shows it passes, then shows the binding
rejects them — in **both** languages, over a tampered copy in a temp dir.

Full schema validation stays in `validate.mjs`, exercised by
`server/test/domain-schema.test.mjs` and
`server/test/domain-reasons-schema.test.mjs` on the same CI run. It is deliberately
**not** imported by either binding: doing so would ship the Draft-07 engine and
the schema into the browser bundle for a check CI already performs. The honest
limit of that trade is one line down in "What is deliberately NOT here."

## The two shapes

The bindings deliberately ship different shapes. `domain-binding-hygiene.test.mjs`
pins both, so a hand edit cannot flip one silently.

- **`js/lifecycle.js`** carries the **authored** entries verbatim: both kinds,
  `runsIn` and the farm-only fields included (`server/src/config.js`'s
  `FARM_STEP_INDEXES` and `farmd`'s lane routing need `runsIn`), no synthesised
  `index` — a step's position *is* its index — and `agent`/`gate` **absent** on
  the opposite kind rather than `null`.
- **`py/steps.py`** carries the **farm projection** (`_project_farm_view`):
  agent-kind entries only (both lanes, since `farmd`'s `/steps/run` routes on
  `runsIn`), each with its own `index`, farm-only fields present as `None` on
  the PM lane, and no `requires` — that gates a server-side dispatch decision,
  never a farm one.

The projection rule lives in Python and nowhere else in production code.
`domain-parity.test.mjs` reimplements it inline, on purpose, so the comparison
is a genuine second opinion rather than an implementation checked against
itself.

### The reason bindings ship ONE shape, on purpose

The failure vocabulary has **no** farm projection. The tag the farm emits, the
tag the server classifies and the tag the UI renders are the same string — that
is the entire point of the file — so both bindings expose `reasons.json`
verbatim and `domain-binding-hygiene.test.mjs` pins that they do.

They differ in exactly one way, and it is a language difference rather than a
model one. `REASON` is a **dict** in Python, so `reasons.REASON["TYPO"]` raises
`KeyError` at the call site. In JS it is a frozen object, so `REASON.TYPO` reads
as `undefined` — silently unclassified, silently not retried. Nothing in JS can
close that gap, so `server/test/domain-reason-member-access.test.mjs` scans
every `REASON.<KEY>` access in `server/src` and `ui/src` instead.

`AUTO_RETRY_REASONS` is **derived** from the `retryable` flag in both languages,
never a second list — a `Set` in JS because `failFarmRun` calls `.has()` on it,
a `frozenset` in Python so the farm cannot widen the server's retry policy.
Both types are pinned: a derived Array would answer `undefined` to `.has()` and
quietly pause every transient failure.

### The field bindings ship ONE shape too, for the same reason

There is no projection here either. The length the API enforces at intake and the
length a PM revision is held to are the **same number** — that is the entire
point of `fields.json`, and the bug HZ-134 closed was precisely that they were
not. Both bindings expose the authored table verbatim.

Each field carries **two names**, and the difference is the file's other job:

- **`name`** — the field's name on the API, i.e. the `POST /api/items` body key.
- **`column`** — its `work_item` column, which is also the key a PM patch and the
  `UPDATE work_item` statement use.

They differ for exactly one field: `outcome` is stored in `desc`. That mapping
used to be implicit in two unrelated files, with each side re-deriving it. It
lives here now and nowhere else.

The two flags say who may write the field, in domain language rather than layer
language:

- **`settableAtIntake`** — a human may set it when the item is created.
  `intakeFields()` is what `POST /api/items` builds its body properties from.
  `persona` is deliberately false: it is assigned by an agent or at a gate.
- **`agentRevisable`** — an agent may patch it later. `patchLimits()` keys by
  `column` and is what `farm/pm_agent.py`'s `PATCH_FIELDS` and
  `server/src/orchestrator.js`'s `FARM_PATCH_FIELDS` both are, so the two sides
  of the wire cannot disagree about which fields exist.

Three things adjacent to a field limit are deliberately **not** here:

- **`required: ['title', 'outcome', 'metric']`** stays a literal in
  `server/src/app.js`, and so does the `priority` enum. Neither is a length, so
  neither belongs in a file about lengths — but it does mean the same route reads
  from two homes. `api-field-limits-derived.test.mjs` asserts every `required`
  name is a property the derived fragment defines, so the split cannot silently
  break.
- **`PATCH_FIELD_LABELS`** (`server/src/orchestrator.js`) — "Outcome", "Success
  metric". Display copy, which guardrail 5 keeps out of `domain/`.
  `domain-fields-consumers.test.mjs` drives `stepCommentBody` with every patchable
  column set, so a field written to the database but missing from the comment
  fails.
- **`MARKED_PATCH_FIELDS`** (`farm/pm_agent.py`) — which over-long fields get a
  truncation marker. A marking policy, not a limit.

**`maxLength` is an INTAKE cap, not a database invariant.** HZ-114's truncation
marker is appended *after* the cut, so a PM revision that ran over lands in
`work_item` **longer** than the declared maximum for that column — content inside
the budget, note outside it. That is intended: squeezing the marker inside the
budget would eat real content to make room for a message about eating real
content. Pinned by `farm/tests/test_field_limits.py`.

**Two over-limit values are deliberately not marked.** Both predate HZ-134 and
are unchanged by it, but "every over-limit value is marked" is the obvious wrong
reading of the rule above, so they are stated here rather than left to a reader
who trusts it:

- **`persona`** is not in `MARKED_PATCH_FIELDS`. It is a registry-validated
  routing id, not prose, and a value that overruns its declared cap matches no
  known persona and is discarded either way — so it is hard-sliced, silently.
  `test_validate_persona_stays_hard_capped_with_no_marker` pins that, deriving
  the cap from the declaration so it cannot go vacuous.
- **A single run-on token with no space anywhere** (a URL or a hash longer than
  the whole budget) is returned whole and unmarked. `_mark_truncated` has no
  boundary to cut at, and cutting mid-token would corrupt the value rather than
  shorten it.

One more caveat, on the field taking the biggest jump: a long `outcome` revision
is **reverted by the next GitHub webhook sync**. `store.js`'s `upsertFromGithub`
rewrites `desc` from the parsed issue body unconditionally, where `metric` and
`guardrails` have an `|| row.metric` fallback. Pre-existing at any cap length and
out of scope here — which is why `guardrails`, not `desc`, is the field
`server/test/pm-revision-full-length.test.mjs` proves the full-length write on.

## Consumers

Imported by relative path. No npm workspace, no published package, no new
dependency — the folder is *shaped* so it could become a package later without
moving again, but it is not one today (`domain-no-drift-scaffolding.test.mjs`
asserts that, including that `domain/package.json` does not exist).

| Consumer | How |
| --- | --- |
| `server/src`, `server/test` | `import … from '../../domain/js/lifecycle.js'` |
| `ui/src` | `import … from '../../../domain/js/lifecycle.js'` |
| `e2e/` | `import … from '../domain/js/lifecycle.js'` |
| `farm/` | `from domain.py import fields, priorities, reasons, steps` |

The reason vocabulary has two consumers, by the same relative paths:
`server/src/orchestrator.js` (which classifies a failure) and
`ui/src/domain/pauseReason.js` (which renders the pause banner). The farm reaches
it through `reasons.REASON[…]` in `farm/step_agent.py`, `farm/farmd.py` and
`farm/pm_agent.py`.

The priority vocabulary has the widest consumer list of the four, which is why it
was the most duplicated: `server/src/db.js` (the `CHECK` constraint),
`server/src/store.js`, `server/src/github.js`, `server/src/app.js` and
`server/src/priorityLabels.js` on the server; `ui/src/components/NewItemModal.jsx`,
`ui/src/domain/lifecycle.js` and `ui/src/api/mockApi.js` in the UI; and
`farm/wizard.py` plus `farm/concierge_agent.py` in the farm.

`server/src/priorityLabels.js` is new and is **not** part of `domain/`. It owns
GitHub's *spelling* of a priority — the `priority: critical` label name, the
pattern that reads one back, and `priorityFromLabels` — which is an integration
detail, not domain data. Before HZ-135 the pattern existed twice byte-for-byte
(`store.js` and `github.js`, under two different names) and the name format lived a
file away from it, so we could have written a label the next sync could not read
and silently reverted a human's change on the following webhook.

The field limits have **no UI consumer**, and that is a real gap rather than a
design choice: `ui/src/components/NewItemModal.jsx` sets no `maxLength`, so a long
paste reaches the API and comes back 400. Pre-existing, unchanged by HZ-134, and
recorded here rather than left to be rediscovered.
`domain-consumer-imports.test.mjs` would fail on a stale `ui/src` entry, so adding
one later is a deliberate act.

The Python side is a PEP 420 namespace package: no `__init__.py` at either
level, resolved off the repo root — which is on `sys.path` because `farmd` runs
as `python -m farm.farmd` from there and `farm/tests/conftest.py` inserts it.
`farm/tests/test_domain_import.py` is the guard on that.

`ui/vite.config.js` sets `server.fs.allow = ['..']` because `domain/` is
outside the Vite root: `vite build` and `vitest` resolve it on their own, but
the dev server would 403 without the allowlist.

The root `package.json` pins `engines.node >= 22`, because the JSON import
attribute is a **syntax** error before Node 20.10 — without the pin the server
would pass CI and fail at deploy time on an older runtime.

## What is deliberately NOT here

**No presentation.** `AGENTS` colours, `PHASE_ACCENT`, `PHASE_ACCENT_BG`,
`PRIORITY_COLORS` stay in the UI (`ui/src/domain/lifecycle.js`,
`ui/src/domain/agentTokens.js`), and `PRIORITY_LABEL_COLORS`' hex stays in
`server/src/github.js` because it is persisted to GitHub, which has no idea what a
CSS variable is. Both of those maps now **key off** `PRIORITY.*` rather than
re-typing the vocabulary — keyed by named constant, not by array position, so a
reordered `priorities.json` cannot silently recolour anything. `steps.json` contains no colour, accent or
theme key at any depth, asserted.

`reasons.json` is held to a **wider** bar than `steps.json` on this, because the
temptation is different. Sitting a `label` and a `detail` next to the `retryable`
flag would read as harmless data and would move the pause banner's wording out
of the UI. So `reasons.json` forbids `label`/`detail`/`copy`/`title`/`message`
keys as well as colours, and `domain-binding-hygiene.test.mjs` asserts it.
`steps.json` cannot join that half: a step's `label` **is** its identity, the
thing every lookup resolves by, not a string shown to a human.

**The one surviving duplicate.** `server/src/agentTokens.js` and
`ui/src/domain/agentTokens.js` both export `AGENTS`, and their `label` /
`initials` fields are the same by hand. They cannot merge: the server persists
a literal hex into an activity event's `color` column, and the UI renders a
theme-aware token (`var(--primary-ink)`) that
`ui/src/domain/eventColors.js` maps the stored hex onto. The duplication is
**reduced, not eliminated** — `domain-no-duplicate-exports.test.mjs` asserts the
overlap is exactly `{AGENTS}` and `personas.test.mjs` asserts the shared fields
still agree.

**`ui/design-system/Lifecycle Tracker.dc.html`** holds a third hand-copy of
the step labels — and, at line 352, a hand-copy of the priority colour map — and is
**explicitly excluded** from both the
"no step declared outside `domain/`" check (see `EXCLUDED_DIRS` in
`server/test/domain-one-declaration.test.mjs`) and the priority equivalent
(`domain-priority-literals.test.mjs`). The priority detector *does* fire on that
line; the file is excluded for what it is, not because the detector is wrong. It is a Design Compiler export:
non-executing, in no build, in no bundle, imported by nothing, and re-emitted
wholesale by the design tool. Nothing here can own it, and pinning its labels
would turn a design re-export into a test failure.

**Schema-only violations do not fail at import.** A `maxTurns` of the wrong
*type* loads fine in both bindings; a bad shape, a duplicate label or an
out-of-range phase does not. Closing that gap would mean a second, hand-written
schema validator in Python — exactly the duplicated logic this folder exists to
avoid. `domain-schema.test.mjs` catches it on the same CI run instead. Recorded
here as a known limit, not hidden.

## Safeguards, and what each actually proves

| Guard | Where | What it catches |
| --- | --- | --- |
| Schema + cross-field rules | `domain-schema.test.mjs` | An invalid table: bad kind, bad budget, missing farm field, duplicate label, out-of-range phase — including a real subprocess `import` over a tampered `steps.json`, which is what proves the binding *calls* its own validator |
| Cross-language fixtures | `fixtures/lifecycle-cases.json` + `domain-fixture-cases.test.mjs` + `farm/tests/test_lifecycle_fixtures.py` | The two bindings disagreeing about what a lookup, a projection or a validation rule *means*. Both suites run the same `shared` cases and assert they ran the pinned list |
| Hand-written label/order/budget pins | `domain-step-pins.test.mjs` | A renamed, reordered or re-budgeted step (guardrail 9). **Permanent — never delete this file** |
| Cross-language parity | `domain-parity.test.mjs` | The two bindings drifting. Its **load-bearing** leg is the spawned `python3` import, diffed against the JS binding |
| `STEP_CONFIG` drift | `farm/step_agent.py` (import time) + `farm/tests/test_step_agent.py` | A farm-lane step with no role config, or vice versa |
| `MOCK_STEP_BEHAVIOR` drift | `server/test/mock-step-behavior-drift.test.mjs` | The JS analogue of the above — demo mode and the whole e2e suite run on that map |
| Role-prompt labels | `server/test/role-prompt-labels.test.mjs` | `farm/roles/*.md` instructing an agent about a step that no longer exists |
| One declaration | `domain-single-source.test.mjs`, `domain-one-declaration.test.mjs` | A new hand-rolled copy of the table anywhere in the tree — including either binding growing one back |
| One lookup name | `domain-one-lookup-name.test.mjs` | The discarded `requiredIndex` name resolving again |
| Reason schema + load-time rules | `domain-reasons-schema.test.mjs` | An invalid vocabulary: a bad id shape, a duplicate id, a truthy-but-not-boolean flag, nothing retryable — including a real subprocess `import` over a tampered `reasons.json` |
| Hand-written reason pins | `domain-reason-pins.test.mjs` | Any change to the five declared ids or the four retryable ones, plus the `Set`/`frozenset` types `.has()` depends on. **Permanent — never delete this file** |
| No reason literal anywhere | `domain-reason-literals.test.mjs` | A reason string typed by hand in `server/src`, `ui/src` or `farm/`, and a second *collection* of reason ids anywhere outside `domain/` |
| No mistyped `REASON` key | `domain-reason-member-access.test.mjs` | `REASON.TYPO` in JS, which reads as `undefined` instead of throwing the way Python's dict does |
| Cross-language reason parity | `domain-reasons-parity.test.mjs` + `farm/tests/test_reasons.py` | The two reason bindings drifting. Compares the **paired** `(id, retryable)` table, not two independent lists |
| Every reason has banner copy | `ui/src/domain/pauseReason.test.js`, `ui/src/components/Tracker.test.jsx` | A reason declared in `reasons.json` that renders a blank pause banner — driven through the real `pauseReason()`, so it also proves the event-text regex extracts the id |
| Field schema + load-time rules | `domain-fields-schema.test.mjs` | An invalid field table: a missing column, a zero `maxLength`, a duplicate name or column, a `minLength` at-or-above its own `maxLength`, nothing settable at intake, nothing agent-revisable — including real subprocess imports, in **both** languages, over a tampered `fields.json` |
| Cross-language field fixtures | `fixtures/fields-cases.json` + `domain-fields-cases.test.mjs` + `farm/tests/test_fields_fixtures.py` | The two field validators disagreeing about what a rule *means*, or their messages drifting. Same set-equality / non-empty / pinned-manifest guards as the lifecycle fixture |
| Cross-language field parity | `domain-fields-parity.test.mjs` | The two field bindings drifting. Compares the authored table AND the derived `patch_limits` **including key order**, which `validate()` and `FARM_PATCH_FIELDS` both depend on |
| API limits are derived | `api-field-limits-derived.test.mjs` | A stale `maxLength` literal in `POST /api/items`. Posts each field at exactly its limit and one over, **through the real route** — plus a structural diff of the fragment against `fields.json` |
| PM limits are derived | `farm/tests/test_field_limits.py` | `PATCH_FIELDS` drifting from the declaration (order included), a superseded cap reappearing in `pm_agent.py`, a `pm.md` that lost its `{{FIELD_LIMITS}}` placeholder, and the marker-overshoot behaviour above |
| One field declaration | `domain-one-field-declaration.test.mjs` | A second copy of a field limit anywhere in the tree — structurally (three or more field/limit pairs in one file) and per-pair (set-equality allowlist) |
| Every column is real | `domain-fields-consumers.test.mjs` | A typo'd `column` in `fields.json`, which `completeFarmRun`'s `UPDATE work_item SET <column> = ?` would otherwise turn into a runtime SQL error mid-run. Checked against a real database via `PRAGMA table_info` |
| A PM revision can fill the field | `pm-revision-full-length.test.mjs`, `farm/tests/test_pm_agent.py` | A cap reappearing anywhere on the write path. Drives a 1,999-char `guardrails` revision through the real `POST /api/farm/steps/:runId/complete` and asserts the stored value byte-for-byte |
| Priority schema + load-time rules | `domain-priorities-schema.test.mjs` | An invalid vocabulary: a value that could not be safely interpolated into SQL, a case-only duplicate, a default outside the vocabulary, an empty list — including real subprocess imports, in **both** languages, over a tampered `priorities.json`. Also asserts the schema/load-time split is real by showing the schema passes what only the binding rejects |
| Cross-language priority fixtures | `fixtures/priorities-cases.json` + `domain-priorities-cases.test.mjs` + `farm/tests/test_priorities_fixtures.py` | The two priority validators disagreeing about what a rule *means*. Same set-equality / non-empty / pinned-manifest guards as the other two fixtures |
| Cross-language priority parity | `domain-priorities-parity.test.mjs` | The two priority bindings drifting. Compares the vocabulary **as an ordered sequence**, the default, and every `isPriority`/`is_priority` answer — plus that the Python side is a `tuple`, so the farm cannot widen what the server enforces |
| Message parity across languages | `farm/tests/test_priorities.py` | The two validators' error text drifting outside the fragment the fixture compares — e.g. Python's `json.dumps` spacing. Runs every rule through both implementations and diffs the FULL messages |
| Hand-written priority pins | `domain-priority-pins.test.mjs` | Any change to the four values, their ORDER, the default, the emitted SQL `CHECK` clause, the GitHub label name format, every label hex, every theme token, or the prose list in `concierge.md`. **Permanent — never delete this file** |
| No priority literal LIST anywhere | `domain-priority-literals.test.mjs` | A second declaration of the vocabulary, whole-tree, in any of the three shapes one takes: a quoted collection, an unquoted key set, or a regex alternation. Also names all ten repointed sites individually, so a gutted consumer fails |
| GitHub label behaviour | `priority-labels.test.mjs` | Metric 4, which had **zero** coverage before HZ-135. The `priorityFromLabels` matrix through the real `upsertFromGithub`, and `setPriorityLabel`'s exact POST bodies, stale-label `DELETE` and colour fallback against a stubbed `fetch` |
| The API enums are derived | `api-priority-enum-derived.test.mjs` | A stale priority literal in `POST /api/items`. Posts every declared value through the real route and reads the stored value back, plus a structural diff of the exported fragment against `priorities.json` |
| The UI picker is derived | `ui/src/components/NewItemModal.test.jsx` | Metric 2's UI leg, which had no test at any level. Renders the real modal and asserts the options equal the vocabulary **in order**, one per value, with the declared default selected |
| The wizard's text has not moved | `farm/tests/test_wizard.py` | A renumbered or reworded WhatsApp prompt. Both emitted strings pinned byte-for-byte, because for a bot the emitted string IS the behaviour |

One honest limit remains: `domain-no-drift-scaffolding.test.mjs`'s
`server.fs.allow` assertion is a **config-shape proxy**, not a dev-server boot
test; it is labelled as such in the test.

### How the priority no-literal scan differs, and why

`domain-priority-literals.test.mjs` is metric 3's mechanism, and it is shaped
differently from the reason scan below — deliberately, because the vocabularies are
different in kind.

**There is no single-literal tier.** Every priority value is an ordinary English
word. `High`, `Medium` and `Low` appear as *one-value* fixture data in fourteen
files that are all perfectly legitimate — a board test's `priority: 'Medium'`, an
e2e fixture row, a demo seed. A scan for those would be a fourteen-entry allowlist
protecting nothing. Metric 3's word is **list**, so the scan detects
**collections** only: three or more distinct values inside a three-line window.

**Three shapes count as a collection**, because the vocabulary was written in all
three before this change:

- a **quoted** collection — `['Critical', 'High', …]`, `("Critical", …)`;
- an **unquoted key set** — `{ Critical: '9C333E', High: 'DFA200', … }`, which is
  exactly what both colour maps were. Without this tier the scan would have passed
  on the two files the change works hardest on, and the named-constant keying
  would be unverified ceremony;
- a **regex alternation** — `(critical|high|medium|low)`, the folded form, which is
  how the label pattern spelled the list in two files at once.

**One exclusion makes it usable**, and it is structural rather than an allowlist:
a value in **object-property value position** (preceded by `:`) does not count.
That is what clears `server/src/db.js`'s demo seeds, `ui/src/api/mockApi.js`'s,
`e2e/global-setup.js`'s and the Design Compiler export's — four production and
fixture files, none of which needed naming. An *array element* is preceded by `[`
or `,`, so a real list still fires, including inside `"priorities": [...]`.

**The accepted limit, stated rather than hidden:** a map keyed *by number* whose
values are priorities — `{"1": "Critical", "2": "High", …}`, which is what
`wizard.py`'s `_PRIORITY_NUMS` used to be — escapes the value-position exclusion
and matches neither other tier. That specific shape is covered instead by
`by_number`'s fixture cases and by `test_the_numbering_helpers_follow_their_argument_not_the_live_document`.

Two files outside `domain/` may hold a collection, by set equality so a stale entry
also fails: `domain-priority-pins.test.mjs` (typing the values out *is* what a pin
is) and `farm/tests/fake_claude` (a stand-in for the `claude` CLI, exec'd by bare
name from an arbitrary workspace clone with no package context, so it cannot reach
`domain.py`).

`farm/roles/concierge.md` is correctly **not** a hit: only one value is quoted
there, and the other three are bare prose. It is pinned separately, anchored on
content rather than a line number, because it is an LLM prompt and rewriting it
would be the behaviour change guardrail 1 forbids.

### How the no-literal scan actually works

`domain-reason-literals.test.mjs` is the mechanism that closes the typo class
HZ-132 exists to kill, so its pattern is part of the contract rather than an
implementation detail. It is **two-tier**, over comment-stripped text, scoped to
the three roots the criterion names (`server/src`, `ui/src`, `farm/`):

- `never_picked_up`, `turn_cap` and `required_input_incomplete` are matched as
  **bare words**. They appear nowhere else in this repo, and a bare-word rule is
  strictly stronger — it catches an unquoted object key, which was exactly the
  old shape of `CATEGORY_COPY`.
- `timeout` and `unreachable` are ordinary words (`timeout` is a Playwright
  option, an `httpx` kwarg and a config key). Matching them bare hits 70+ files.
  They are matched only in **reason-shaped positions**: inside quotes, or inside
  the parentheses of a `(reason)` event tag.

Comments are stripped on both sides, `#` included, so provenance prose is left
alone rather than reworded to satisfy a scanner. Three `farm/tests/` files are
allowlisted by name, each with its reason — two pin the exact value on the wire,
one is a genuine false positive (`kwargs.get("timeout")`).

`server/test` and `e2e/` are **out of scope on purpose**:
`domain-reason-pins.test.mjs` has to type the ids by hand — that is what a pin
is — and `e2e/tests/13-pause-reason.spec.js` runs byte-identical as the
behaviour-unchanged proof. The wider "no second definition outside `domain/`"
guardrail is covered separately, whole-tree, by looking for a *collection* of
three or more ids rather than by counting mentions per file.

## Gate cost

`npm test` runs `ui/scripts/verify-base-build.mjs`, which executes the literal
`HORIZON_BASE=/horizon/ npm --prefix ui run build`, asserts the emitted
`ui/dist/index.html` references `/horizon/assets/` **and that the emitted JS
bundle contains a step label, a reason id and the whole ordered priority
sequence**, then deletes `ui/dist` so no `/horizon/`-based
bundle is left for a local `vite preview`. **Measured: ~2.7s** (2.1s of that is
Vite). The bundle-contents assertion is the one that matters here: a build can
succeed while emitting `steps.json` as a separate asset that then 404s under the
`/horizon/` base, leaving the board empty in production with every suite green.

There is **no linter** in this repo. Neither the root nor `ui/package.json`
defines a `lint` script, and `farm/checks.py` only runs one if present — so the
linter leg of the guardrail gate is a **no-op**. A green gate is not lint
coverage. These files are now *lintable*, which they were not before; nothing in
CI yet proves they are lint-clean. Adding a linter stays out of scope (it needs
a dependency).
