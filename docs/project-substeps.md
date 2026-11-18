# Turn on "Design the screens" for your project

HO-854. This guide is for the owner of a project with a UI. It shows how to add
the "Design the screens" sub-step to your project's flow. In that sub-step an
agent designs the item's screens on a Studio canvas, right after "Define how we
measure success".

Horizon turned it on for itself with `farm/projects/horizon/steps.json`. That
file is the worked example below.

## Where the file goes

`farm/projects/<slug>/steps.json`, in the Horizon repo.

- `<slug>` is your project's name in lower case. Every character that is not
  `a`–`z` or `0`–`9` becomes `-`, and dashes at either end are trimmed. So
  `Horizon` is `horizon` and `Acme Capital` is `acme-capital`.
- Add it in one of two ways:
  - Open a reviewed PR that adds the file.
  - Or save it from Horizon: `PUT /api/projects/<slug>/definitions/steps.json`.
    Horizon commits and pushes the file for you. The call asks for your PIN.
- The file holds sub-steps only. It never adds or renames a global step, and a
  sub-step never has a gate of its own.

## What to put in it

Horizon's file, in full:

```json
{
  "substeps": [
    {
      "id": "design-screens",
      "label": "Design the screens",
      "kind": "opening",
      "anchor": 1,
      "output": "design",
      "applies": { "repos": ["FinTekkers/horizon"] }
    }
  ]
}
```

Copy it, and change `applies` to name your own repos. The allowed keys are
`id`, `label`, `kind`, `anchor`, `persona`, `output` and `applies`. Any other
key is refused. So is `gate`, whatever its value. `persona` is optional.
Horizon leaves it out.

## How `anchor` works

`anchor` is the index of the global step the sub-step follows. It is a number,
not a label, so renaming a step can never move a sub-step.

- An `opening` sub-step follows a definition step. `1` is "Define how we
  measure success", on Change items. `17` is "How we'll verify", on Task items.
- An `audit` sub-step follows "Specialist agent implements" or "Execute".
- A sub-step only applies to the item kind its anchor belongs to. With anchor
  `1`, Task items never get it.

## The `output` value

"Design the screens" uses `"output": "design"`. It means a Studio design
canvas, made by the farm with `meta studio.canvas apply` (HO-850). The run's
artifact starts with the canvas link, and a later round updates the same
canvas.

The other outputs exist for other sub-steps. An `opening` sub-step may also use
`artifact` (a markdown artifact) or `golden_cases`. An `audit` sub-step uses
`findings`.

## Which items get it: `applies`

`applies` holds up to three lists: `labels`, `repos` and `paths`. An item gets
the sub-step when any one list matches. They are OR'd, so you cannot say "this
repo AND this label".

- `repos`: the item's repo, ignoring case. Horizon uses this, so every new
  Horizon Change item gets the sub-step.
- `labels`: any of the item's GitHub labels, ignoring case.
- `paths`: globs matched against the paths written in backticks in the item's
  description. An item has no changed files yet when it is created.

## Credential

The design sub-step needs **no credential env var of its own**.

- Studio runs on the host as the farm user, on the box's own certificate. There
  is no API key, browser login or connector to set up.
- The farm removes `$ANTHROPIC_API_KEY` from Studio's environment.
- The one env var involved is your repo's test-login variable. The screenshot
  runner uses it to log in when it captures the built screens, which
  Automated review compares with the approved canvas (HO-852). For Horizon
  that variable is `$SCREENSHOT_LOGIN_KEY`. Each project names its own. Set it
  in your repo's test env file on the host, as
  [`e2e-screenshots.md`](e2e-screenshots.md) describes. Never put its value
  in a doc, a rule or `steps.json`.
- A tenant project's design sub-step does not run. Studio runs as the box's
  owner, so a tenant's item never reaches it.

## The `definitions_enabled` switch

`project.definitions_enabled` **defaults to `1`** (on) for every project. The
one exception is the `Unlinked items` project, which is created with `0`.

- When it is `1`, the file is read for each new item.
- When it is `0`, the file is never read and new items get no sub-steps. This
  is also the fast way to turn the sub-step off without a deploy.
- An owner switches it with `POST /api/projects/<id>/definitions-enabled`.

## Intake freeze: new items only

Horizon takes a snapshot of the sub-steps that apply when an item is created,
and stores it on the item. A later GitHub sync never changes that snapshot.

- Adding, editing or deleting the file affects **new items only**. Items that
  already exist keep the flow they started with.
- The file is read for each new item and is not cached. It is **not** loaded
  at startup. A change goes live once the host's checkout has it, which for a
  PR means the next Horizon deploy.

## If the file is wrong

One bad entry rejects the whole file. New items then get no sub-steps at all,
and the server logs a line that names the sub-step id. Item sync keeps
working.

Run **Validate project** after you add or change the file. Its `rules` check
fails with `steps.json:` and the errors, each naming the sub-step id.

## What happens when it runs

Dispatch shipped in HZ-539. The design flow shipped in HO-850 and HO-851.

1. "Define how we measure success" also records one verdict line:
   `design_needed: yes — <reason>` or `design_needed: no — <reason>`.
2. `no` with a reason skips the sub-step. The tracker shows
   "Skipped: <reason>" and the item moves on. At a gate, an owner can still
   press "Design it anyway", give a reason and the gate PIN, and force a
   round.
3. Anything else runs it, including a missing or unreadable verdict. Horizon
   never skips on a guess. The agent designs, and the farm makes or updates
   the item's Studio canvas.
4. At the first gate the approver approves the latest canvas, or approves
   without a design and says why. The approved canvas is the spec for Plan
   options, Implement and Automated review (HO-852).
5. A send-back from a gate can target "Design the screens". The new round goes
   straight back to that gate when "Set guardrails" does not need to re-run.
