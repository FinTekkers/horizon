"""Regenerates the HZ-371 PM prompt snapshots from task.json.

    python farm/tests/fixtures/pm_prompts/regen.py [--module farm.pm_steps]

Writes step_<index>.txt (build_prompt for each runsIn "pm" step, with the
task's step swapped in) and role_prompt.txt (the rendered ROLE_PROMPT). The
committed outputs were captured from the PM runner on main before HZ-371
moved it; regenerate only when a PM prompt change is intended.
"""

import argparse
import copy
import importlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[3]))  # repo root, for `farm` and `domain`


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--module", default="farm.pm_steps")
    args = parser.parse_args()
    module = importlib.import_module(args.module)
    from domain.py import steps

    task = json.loads((HERE / "task.json").read_text())
    for step in steps.STEPS:
        if step["runsIn"] != "pm":
            continue
        step_task = copy.deepcopy(task)
        step_task["step"] = {"index": step["index"], "label": step["label"]}
        (HERE / f"step_{step['index']}.txt").write_text(module.build_prompt(step_task))
    (HERE / "role_prompt.txt").write_text(module.ROLE_PROMPT)


if __name__ == "__main__":
    main()
