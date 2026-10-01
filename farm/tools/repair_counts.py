"""Print how often each reply-repair path has fired (HZ-157 success metric).

    $ python -m farm.tools.repair_counts
    reply repair counts — /home/you/.horizon-farm/state/parser-repairs.json
    (indicative totals: several farm processes tick this file, so a
    simultaneous tick can lose one increment)
      trailing_comma      12
      single_quotes        3
      TOTAL               15

Reads the counter farm/agent_runner.record_repair() maintains. Every total this
script prints corresponds to a run that also carried a parser note in its
output line and its artifact — the counter is the aggregate view of those
notes, never a substitute for them.

This module does NO parsing of its own: it imports repair_counts() from
agent_runner, which is the one module allowed to (HZ-156, enforced by
farm/tests/test_one_reply_parser.py).

Output is never empty. With no counter file yet, every known rung prints a zero
row — "this has never fired" is a real answer and must be distinguishable from
"the script found nothing to say".
"""

import argparse
import json
import sys
from pathlib import Path

from ..agent_runner import REPAIRS, REPAIR_COUNTS_PATH, repair_counts


def rows(counts: dict[str, int]) -> list[tuple[str, int]]:
    """Every known rung in ladder order, then any unknown key found in the file.

    Unknown keys are printed rather than dropped: record_repair() preserves
    them on write, so a rung added by a later item (or removed by a revert)
    still has its totals visible here instead of silently disappearing.
    """
    known = [(rung.name, counts.get(rung.name, 0)) for rung in REPAIRS]
    extra = sorted((name, n) for name, n in counts.items() if name not in {r.name for r in REPAIRS})
    return known + extra


def render(counts: dict[str, int], path: Path) -> str:
    lines = [
        f"reply repair counts — {path}",
        "(indicative totals: several farm processes tick this file, so a simultaneous "
        "tick can lose one increment)",
    ]
    table = rows(counts)
    width = max((len(name) for name, _ in table), default=5) + 2
    for name, count in table:
        lines.append(f"  {name:<{width}}{count:>6}")
    lines.append(f"  {'TOTAL':<{width}}{sum(count for _, count in table):>6}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print reply-repair counts per path.")
    parser.add_argument(
        "--path",
        default=None,
        help=f"counter file to read (default: {REPAIR_COUNTS_PATH})",
    )
    parser.add_argument("--json", action="store_true", help="emit the totals as JSON")
    args = parser.parse_args(argv)

    path = Path(args.path) if args.path else REPAIR_COUNTS_PATH
    counts = repair_counts(path)
    if args.json:
        print(json.dumps(dict(rows(counts)), indent=2, sort_keys=True))
    else:
        print(render(counts, path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
