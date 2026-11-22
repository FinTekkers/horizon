"""HZ-951: streams one JSON line per test start and finish to
$HORIZON_TEST_REPORT_DIR/pytest.jsonl, so a run killed at its time limit
still leaves every finished test on disk and names the one it was running.
The JUnit XML report is unchanged; farm/checks.py's parse_jsonl() reads this
file next to it (HZ-955/948), and an XML row for the same test wins.

Line shape — the one parse_jsonl() reads:
    {"event": "started", "name": <id>, "file": <path>}
    {"event": "finished", "name": <id>, "file": <path>, "status": "pass"|"fail"|"skip",
     "duration_ms": <int>, "failure": <str, on fail only>}
`file` is the node id's file part and `name` the rest (`TestY::test_a[p]`),
so a row matches pytest's xunit2 classname (_xml_duplicate()).
`duration_ms` is the sum of the setup, call and teardown phases.

Each line is one os.write on an O_APPEND fd: nothing is buffered, so a
SIGKILL loses at most the line being written. The hooks only read reports.
Any error turns the stream off for the rest of the run and is never raised,
so a missing or broken report only loses detail, never a test's result.

Loaded by conftest.py, or into a throwaway run with
`-p farm.tests.report_stream` (test_report_stream.py). Kept free of other
farm.* imports for that.
"""

import json
import os

PLUGIN_NAME = "hz951-report-stream"
REPORT_DIR_ENV = "HORIZON_TEST_REPORT_DIR"
REPORT_FILE = "pytest.jsonl"
# The farm reads at most this much of a failure (FAILURE_TEXT_MAX_CHARS).
FAILURE_MAX_CHARS = 4000
_STATUS = {"passed": "pass", "failed": "fail", "skipped": "skip"}


class ReportStream:
    def __init__(self, report_dir: str | None) -> None:
        self._dir = report_dir or None
        self._fd: int | None = None
        self._broken = False
        # nodeid -> {phase: report} for the test in progress.
        self._phases: dict[str, dict] = {}

    def _write(self, entry: dict) -> None:
        if self._dir is None or self._broken:
            return
        try:
            if self._fd is None:
                self._fd = os.open(
                    os.path.join(self._dir, REPORT_FILE), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644
                )
            os.write(self._fd, (json.dumps(entry) + "\n").encode("utf-8"))
        except Exception:  # noqa: BLE001 — a report never changes a result
            self._stop()

    def _stop(self) -> None:
        self._broken = True
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None

    @staticmethod
    def _split(nodeid: str) -> tuple[str, str]:
        file, sep, name = nodeid.partition("::")
        return file, name if sep else nodeid

    def pytest_runtest_logstart(self, nodeid, location) -> None:
        if self._dir is None or self._broken:
            return
        try:
            self._phases[nodeid] = {}
            file, name = self._split(nodeid)
            self._write({"event": "started", "name": name, "file": file})
        except Exception:  # noqa: BLE001
            self._stop()

    def pytest_runtest_logreport(self, report) -> None:
        if self._dir is None or self._broken:
            return
        try:
            self._phases.setdefault(report.nodeid, {})[report.when] = report
        except Exception:  # noqa: BLE001
            self._stop()

    def pytest_runtest_logfinish(self, nodeid, location) -> None:
        if self._dir is None or self._broken:
            return
        try:
            phases = self._phases.pop(nodeid, {})
            # The call's outcome; the setup's when it failed or skipped (no
            # call ran); a failed teardown fails the test.
            setup, call, teardown = (phases.get(when) for when in ("setup", "call", "teardown"))
            decisive = call if call is not None else setup
            if decisive is None:
                return
            if teardown is not None and teardown.failed:
                decisive = teardown if not decisive.failed else decisive
            status = _STATUS.get(decisive.outcome, "fail")
            file, name = self._split(nodeid)
            entry = {
                "event": "finished",
                "name": name,
                "file": file,
                "status": status,
                "duration_ms": round(sum(float(r.duration or 0) for r in phases.values()) * 1000),
            }
            if status == "fail":
                entry["failure"] = _failure_text(decisive)
            self._write(entry)
        except Exception:  # noqa: BLE001
            self._stop()

    def pytest_unconfigure(self, config) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None


def _failure_text(report) -> str:
    """The failure's one-line crash message (`AssertionError: assert 1 == 2`),
    else its full text, cut to FAILURE_MAX_CHARS."""
    crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
    text = getattr(crash, "message", None) or getattr(report, "longreprtext", "") or ""
    return str(text)[:FAILURE_MAX_CHARS]


def register(config, report_dir: str | None) -> None:
    """Registers one ReportStream, under PLUGIN_NAME; a second call is a
    no-op, so no line is ever written twice."""
    if not config.pluginmanager.has_plugin(PLUGIN_NAME):
        config.pluginmanager.register(ReportStream(report_dir), PLUGIN_NAME)


def pytest_configure(config):
    register(config, os.environ.get(REPORT_DIR_ENV))
