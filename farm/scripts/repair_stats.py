"""HZ-124 success metric 15: prints how many times each JSON-repair, retry,
salvage, and handoff path has fired, read from the ndjson counter
farm/agent_runner.py's _record_repair() appends one line to per firing.

Run standalone: `python -m farm.scripts.repair_stats`
"""

import argparse
import json
from collections import Counter
from pathlib import Path

from ..agent_runner import REPAIR_STATS_PATH


def count_repairs(path: Path) -> Counter:
    counts: Counter = Counter()
    if not path.exists():
        return counts
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = record.get("path")
        if isinstance(name, str) and name:
            counts[name] += 1
    return counts


def main(path: Path | None = None) -> None:
    counts = count_repairs(path or REPAIR_STATS_PATH)
    if not counts:
        print("no repairs recorded yet")
        return
    for name, count in sorted(counts.items()):
        print(f"{name}: {count}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", type=Path, default=None, help="override the ndjson path (defaults to STATE_DIR)")
    args = parser.parse_args()
    main(args.path)
