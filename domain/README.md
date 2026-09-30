# `domain/` — the lifecycle model

**One JSON is the source of truth. Bindings read it. Consumers import from
here.**

Ask "what is a lifecycle step?" and the answer is this directory, by
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
- **Adding or changing a *helper*** means editing `js/lifecycle.js` or
  `py/steps.py` **directly**. Edit the binding you mean; there is no indirection
  between you and it.

If a helper is meant to behave the same in both languages, add a case to
`fixtures/lifecycle-cases.json` in the same change. The suites on both sides
fail if an export has no case, so this is enforced rather than remembered.

## Layout

| Path | What it is |
| --- | --- |
| `steps.json` | The only place a step is declared |
| `steps.schema.json` | The contract `steps.json` must satisfy |
| `validate.mjs` | Dependency-free JSON Schema (Draft-07 subset) validator, used by the test suite |
| `js/lifecycle.js` | The JS binding: imports `steps.json`, exposes the authored table + derived helpers |
| `py/steps.py` | The Python binding: loads `steps.json`, exposes the farm-shaped table + accessors |
| `fixtures/lifecycle-cases.json` | Input/expected pairs asserted by **both** language suites |

Every file here is authored. Nothing is output.

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

Full schema validation stays in `validate.mjs`, exercised by
`server/test/domain-schema.test.mjs` on the same CI run. It is deliberately
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
| `farm/` | `from domain.py import steps` |

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
`ui/src/domain/agentTokens.js`). `steps.json` contains no colour, accent or
theme key at any depth, asserted.

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
the step labels and is **explicitly excluded** from the
"no step declared outside `domain/`" check (see `EXCLUDED_DIRS` in
`server/test/domain-one-declaration.test.mjs`). It is a Design Compiler export:
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

One honest limit remains: `domain-no-drift-scaffolding.test.mjs`'s
`server.fs.allow` assertion is a **config-shape proxy**, not a dev-server boot
test; it is labelled as such in the test.

## Gate cost

`npm test` runs `ui/scripts/verify-base-build.mjs`, which executes the literal
`HORIZON_BASE=/horizon/ npm --prefix ui run build`, asserts the emitted
`ui/dist/index.html` references `/horizon/assets/` **and that the emitted JS
bundle contains a step label**, then deletes `ui/dist` so no `/horizon/`-based
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
