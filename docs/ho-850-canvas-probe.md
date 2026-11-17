# HO-850 probe: a farm subprocess makes and updates a Studio canvas

**Result: PASS**

Run on this box on 2026-11-17, before any HO-850 code was written. This is the
item's evidence for success metric line 1.

## Why Studio, not a Claude canvas

An earlier probe tried the plan's route: the farm's `claude -p` making the
canvas with its own tool. It failed, as the owner's ruling on this item records.
The farm's `claude -p` goes through the Vertex
gateway and has no canvas tool, and `--strict-mcp-config` loads no canvas
connector. The owner then ruled that HO-850 moves to Meta Studio canvas,
through `meta studio.canvas apply`, and that the Claude route is not retried.
This probe is the new metric line 1 probe.

## What ran

A Python script, run with the farm's own interpreter
(`farm/.venv/bin/python -I`), started each Studio command as a subprocess, as
farm code does:

- **Environment:** copied from the running `farmd` process
  (`/proc/<farmd pid>/environ`), with `ANTHROPIC_API_KEY` removed. A farm
  subprocess inherits exactly this environment.
- **Key unset:** `ANTHROPIC_API_KEY` occurs 0 times in farmd's environment
  (`tr '\0' '\n' < /proc/<farmd pid>/environ | grep -c ANTHROPIC_API_KEY` → `0`).
  The script also recorded `"anthropic_api_key_in_env": false` for the
  environment it passed down.
- **Farm user and HOME:** the farm user `daviddoherty` (the user `farmd` runs
  as), with `HOME=/home/daviddoherty`. Studio runs as that user, on the box's
  own certificate. There is no other credential, no browser, no MCP connector,
  and no Figma login.
- **Tool:** `meta studio.canvas apply`. Its `read` and `system rules`
  subcommands read a canvas and a design system's build rules.
- **Scratch slug:** `horizon-ho-850-probe`.

The commands, in order. Each one adds `-o json`:

1. `meta studio.canvas apply --canvas=horizon-ho-850-probe --calls='[{"tool":"set_surface","args":{"id":"board","system":"xmds","device":"web","width":1280,"height":800}},{"tool":"add_element","args":{"id":"board","html":"<div id=\"title\" …>HO-850 probe: round 1</div>"}}]'`
2. `meta studio.canvas read --canvas=horizon-ho-850-probe`
3. `meta studio.canvas apply --canvas=horizon-ho-850-probe --calls='[{"tool":"edit_surface","args":{"id":"board","find":"HO-850 probe: round 1","replace":"HO-850 probe: round 2"}}]'`
4. `meta studio.canvas read --canvas=horizon-ho-850-probe --surface=board`

## What came back

| Call | Exit | Answer |
| --- | --- | --- |
| 1 create | 0 | `url` https://blueprint-studio.internalmeta.com/canvas/horizon-ho-850-probe, `version` 2, `applied` 2. `set_surface` answered `"created": true`. |
| 2 read | 0 | The same link, `version` 2, one surface `board`, `can_edit: true`. |
| 3 update | 0 | The same link, `version` 3, `applied` 1. |
| 4 read back | 0 | `version` 3. The surface html now reads `HO-850 probe: round 2`. |

- **Canvas link from call 1:** `https://blueprint-studio.internalmeta.com/canvas/horizon-ho-850-probe`.
  It is https on the Studio host, with no query and no fragment. It carries
  no token, so nothing needed redacting.
- **Call 2 outcome:** `updated`. The second round changed the same canvas at
  the same link, and the version went from 2 to 3.
- Each call took 2 to 4 seconds.

Two other answers the design runner relies on, from the same box:

- A refused call exits 1. It answers JSON with `message` (for example
  `call 0 (edit_surface) was refused: find text is not present in surface 'board' …`),
  `error_details.code` `CANVAS_CALL_REJECTED`, and the partial `result`.
- Reading a slug with no canvas exits 1, with `error_details.code`
  `CANVAS_NOT_FOUND`.
- `--calls=file://-` reads the calls from stdin. A long list then never hits
  the argv size cap.

## Redaction

The output above was checked against the farm's redaction set
(`farm/checks.py`'s `secret_values` of the farm's environment, and its token
shapes). It holds no value from that set, no Anthropic API key, and no query
string or fragment in any canvas link. `farm/tests/test_design_substep.py`
checks this file for the same things.
