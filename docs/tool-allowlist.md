# Persona tools: adding a venv to the allow-list by PR

HZ-536. A project persona (`farm/projects/<slug>/personas.json`, HZ-535) can
name extra command-line tools, such as `ruff`. Each tool must be in the farm's
tool allow-list, `farm/tools/allowlist.json`, and each tool runs from its own
read-only venv.

**The allow-list changes only through a reviewed PR.** The server and Admin
never write it, and no Admin page edits it. The farm reads it
(`farm/persona_tools.py`) and writes nothing.

## How it works

- A tool entry looks like this:

  ```json
  { "id": "ruff", "venv": "/opt/horizon-tools/ruff", "commands": ["ruff"] }
  ```

- A project persona names tool ids in an optional `tools` array:

  ```json
  { "id": "quant", "agent": "eng", "label": "Quant", "initials": "QT", "color": "#2E6CB2",
    "model": "<model id>", "provider": "claude", "file": "quant.md", "tools": ["ruff"] }
  ```

- When the farm loads the project's personas, it checks every id against the
  allow-list. An unknown id fails the load, and the error names the id and the
  persona. The project then runs on the global personas, as if it declared
  none.
- When that persona composes into a step, the farm adds these rules to the
  step's fixed tool string (`IMPLEMENT_TOOLS` or `DEVOPS_TOOLS` in
  `farm/step_agent.py`):
  - `Bash(/opt/horizon-tools/<id>/bin/<command>:*)` for each command.
  - `Read(//opt/horizon-tools/<id>/**)`.
- It also denies every write to the venv: `Edit`, `Write` and `NotebookEdit`
  on `//opt/horizon-tools/<id>/**`. No rule that writes is ever added.
- A Bash rule takes the plain absolute path. A file rule's absolute path starts
  with `//`. The two differ on purpose.

## Which steps get persona tools

- **Only a step whose fixed tool string already has bare `Bash`.** Today that
  is the implement step, the only one that both composes a persona and has a
  shell.
- **Read-only steps get nothing.** `PLANNER_TOOLS` has no shell, so a tool such
  as `ruff --fix` could write the worktree. The review passes, the QA steps,
  the planning steps and the plan-bundle steps keep their tool strings byte for
  byte.
- **On the implement step the allow rules grant nothing new.** It already has
  bare `Bash` and `Read`. What the tool adds there is the venv deny rules. Do
  not read the grant as a restriction on other commands.

## Switch off or no persona

With the project's per-project definitions switch off, or with no project
persona on the item, persona tools are ignored. Every step gets byte-identical
`PLANNER_TOOLS`, `IMPLEMENT_TOOLS` or `DEVOPS_TOOLS`, and no deny rules. The
allow-list is not even read. Turning the switch off is the kill switch, with no
deploy needed.

## Providers

Deny rules are enforced only by a provider with `ENFORCES_DENY_RULES` (Claude).
`farm/agent_runner.py` refuses any other provider for a step that carries them,
so a persona with tools fails a step routed to such a provider. It fails
closed, never with the venv writable.

## Adding a venv entry by PR

1. **Build the venv on the host**, at exactly `/opt/horizon-tools/<id>`, owned
   by root, mode `0755`:

   ```sh
   sudo python3 -m venv /opt/horizon-tools/ruff
   sudo /opt/horizon-tools/ruff/bin/pip install 'ruff==<version>'
   sudo chown -R root:root /opt/horizon-tools/ruff
   sudo chmod -R go-w /opt/horizon-tools/ruff
   ```

   Root ownership is the OS backstop: the implement step still has bare `Bash`,
   and the deny rules only cover the agent's file tools.
2. **Add the entry** to `farm/tools/allowlist.json` in a PR, in the `tools`
   array. The rules, all enforced by `lint()` in `farm/persona_tools.py`:
   - `id` matches `^[a-z0-9][a-z0-9_-]{0,31}$` and is unique.
   - `venv` is exactly `/opt/horizon-tools/<id>`. No other path is accepted.
   - `commands` is a non-empty list of bare names under the venv's `bin/`.
     No `*`, no `/`, no spaces, no arguments.
   - No other key. An `env` field is refused by name.
   - Nothing secret-like anywhere: no tokens, keys or `key=`/`token=` pairs.
3. **Run the lint and the tests:**

   ```sh
   pytest farm/tests/test_persona_tools.py
   ```

   `test_the_committed_allowlist_passes_the_lint` fails on a bad entry.
4. **Get the PR reviewed and merged**, then deploy. The farm reads the file
   fresh for each step, so no restart is needed after the deploy.
5. **Name the id** in a project persona's `tools` array, in
   `farm/projects/<slug>/personas.json`, through its own PR.

If the venv's command is missing on the host, a step whose persona names the
tool fails before the agent starts, and the error names the missing path.

## The knowledge extractor (`pdfminer`)

HZ-537. farmd's knowledge job (`farm/knowledge.py`) extracts the PDFs a
project persona names in its `knowledge` array. Its extractor is the
`pdfminer` entry, `pdf2txt.py` from `/opt/horizon-tools/pdfminer`, built as in
step 1:

```sh
sudo python3 -m venv /opt/horizon-tools/pdfminer
sudo /opt/horizon-tools/pdfminer/bin/pip install 'pdfminer.six==20260107'
sudo chown -R root:root /opt/horizon-tools/pdfminer
sudo chmod -R go-w /opt/horizon-tools/pdfminer
```

With the entry removed, or the venv missing, every doc records `failed` and
nothing runs. `pytest farm/tests/test_knowledge.py` fails until it is built.
