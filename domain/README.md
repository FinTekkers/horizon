# `domain/` — the lifecycle model

**One JSON is the source of truth. Bindings are generated. Consumers import
from here.**

Ask "what is a lifecycle step?" and the answer is this directory, by
definition. Before HZ-128 the answer was spread across `server/src/lifecycle.js`,
`ui/src/domain/lifecycle.js`, `farm/steps.py`, two committed
`steps_generated.json` files and a generator living inside one consumer — with
the derived logic hand-copied between server and UI, already diverged
(`requiredStepIndex(label, steps)` vs `requiredIndex(steps, label)`).

## Regenerating

```
npm run gen:domain
```

That is the one command. It runs `node domain/generate.mjs --write`, which
validates `domain/steps.json` against `domain/steps.schema.json` and renders
both bindings from `domain/templates/`.

To check without writing:

```
node domain/generate.mjs --check
```

`--check` exits non-zero and names any binding that differs from a fresh
render. You do not have to remember to run it: `server/test/domain-bindings-zero-diff.test.mjs`
asserts the same thing (plus idempotence and a hand-edit negative control)
inside `npm test`, which `farm/checks.py` runs at the guardrail gate.

## Layout

| Path | Hand-owned? | What it is |
| --- | --- | --- |
| `steps.json` | **authored** | The only place a step is declared |
| `steps.schema.json` | **authored** | The contract `steps.json` must satisfy |
| `validate.mjs` | **authored** | Dependency-free JSON Schema (Draft-07 subset) validator |
| `generate.mjs` | **authored** | Validates, then renders every binding |
| `templates/lifecycle.js.tmpl` | **authored** | The JS helper bodies |
| `templates/steps.py.tmpl` | **authored** | The Python accessor bodies |
| `js/lifecycle.js` | **GENERATED** | Authored table + derived helpers |
| `py/steps.py` | **GENERATED** | Farm-shaped table + accessors |

**Edit the template, never the output.** The helper logic lives in
`templates/`, not in `js/lifecycle.js` or `py/steps.py` — those two are
overwritten on every `--write` and open with a `GENERATED … do not edit`
banner. A hand edit to either fails the zero-diff test with the file named.

Changing the model itself — a step's budget, its lane, its required inputs —
means editing `domain/steps.json` and re-running the command. Adding a *helper* means
editing the template.

## The two shapes

The bindings deliberately ship different shapes. `domain-binding-hygiene.test.mjs`
pins both, so a future regen cannot flip one silently.

- **`js/lifecycle.js`** carries the **authored** entries verbatim: both kinds,
  `runsIn` and the farm-only fields included (`server/src/config.js`'s
  `FARM_STEP_INDEXES` and `farmd`'s lane routing need `runsIn`), no synthesised
  `index` — a step's position *is* its index — and `agent`/`gate` **absent** on
  the opposite kind rather than `null`.
- **`py/steps.py`** carries the **farm projection**: agent-kind entries only
  (both lanes, since `farmd`'s `/steps/run` routes on `runsIn`), each with its
  own `index`, farm-only fields present as `None` on the PM lane, and no
  `requires` — that gates a server-side dispatch decision, never a farm one.

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

**`ui/design-system/Lifecycle Tracker.dc.html`** holds a fourth hand-copy of
the step labels and is **explicitly excluded** from the
"no step declared outside `domain/`" check (see `EXCLUDED_DIRS` in
`server/test/domain-one-declaration.test.mjs`). It is a Design Compiler export:
non-executing, in no build, in no bundle, imported by nothing, and re-emitted
wholesale by the design tool. A generator cannot own it, and pinning its labels
would turn a design re-export into a test failure.

**`py/steps.py`'s `_load_steps` has no production caller.** The table is
embedded, not loaded. It is kept because `farm/tests/test_steps.py` drives all
four of its failure modes (unreadable, malformed, non-array, duplicate labels)
directly. An accepted wart, recorded here rather than only in a template
comment. The import-time guard that *does* run on the embedded table is
`_validate_steps`, tested separately in the same file.

## Safeguards, and what each actually proves

| Guard | Where | What it catches |
| --- | --- | --- |
| Schema + cross-field rules | `domain-schema.test.mjs` | An invalid table: bad kind, bad budget, missing farm field, duplicate label, out-of-range phase |
| Zero-diff regen | `domain-bindings-zero-diff.test.mjs` | A hand-edited or stale binding, with a negative control |
| Hand-written label/order/budget pins | `domain-step-pins.test.mjs` | A renamed, reordered or re-budgeted step (guardrail 9). **Permanent — never delete this file** |
| Cross-language parity | `domain-parity.test.mjs` | The Python binding disagreeing with the generator. Its **load-bearing** leg is the spawned `python3` import — the only genuinely cross-artifact comparison left |
| `STEP_CONFIG` drift | `farm/step_agent.py` (import time) + `farm/tests/test_step_agent.py` | A farm-lane step with no role config, or vice versa |
| `MOCK_STEP_BEHAVIOR` drift | `server/test/mock-step-behavior-drift.test.mjs` | The JS analogue of the above — demo mode and the whole e2e suite run on that map |
| Role-prompt labels | `server/test/role-prompt-labels.test.mjs` | `farm/roles/*.md` instructing an agent about a step that no longer exists |
| One declaration | `domain-single-source.test.mjs`, `domain-one-declaration.test.mjs` | A new hand-rolled copy of the table anywhere in the tree |
| One lookup name | `domain-one-lookup-name.test.mjs` | The discarded `requiredIndex` name resolving again |

Two honest limits. The two JS legs of `domain-parity.test.mjs` are now
generator-output vs generator-output, close to tautological — the spawned
`python3` leg is what carries it, and it is marked load-bearing in that file's
header. And `domain-no-drift-scaffolding.test.mjs`'s `server.fs.allow`
assertion is a **config-shape proxy**, not a dev-server boot test; it is
labelled as such in the test.

## Gate cost

`npm test` runs `ui/scripts/verify-base-build.mjs`, which executes the literal
`HORIZON_BASE=/horizon/ npm --prefix ui run build` and asserts the emitted
`ui/dist/index.html` references `/horizon/assets/`, then deletes `ui/dist` so no
`/horizon/`-based bundle is left for a local `vite preview`. **Measured: ~2.7s**
(2.1s of that is Vite). It exists because `infra/host/test/deploy.test.sh` stubs
`npm` and fakes `dist/index.html` with `printf` — no real `vite build` ran at
the gate before, and `domain/` sitting outside the Vite root is exactly what a
production build can break while every stubbed suite stays green.

There is **no linter** in this repo. Neither the root nor `ui/package.json`
defines a `lint` script, and `farm/checks.py` only runs one if present — so the
linter leg of the guardrail gate is a **no-op**. A green gate is not lint
coverage. Adding one was out of scope here (guardrail 3 forbids a new
dependency).
