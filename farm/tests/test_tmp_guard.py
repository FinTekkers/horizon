"""HZ-238: the /tmp leak guard itself — prove it fails the process and names
what this run left behind, and never blames (or touches) anyone else's dirs."""

import getpass
import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Leftovers verbatim from the 2026-10-02 incident.
INCIDENT_NAMES = ("horizon-personas-abc123", "horizon-gatenotify-x1", "horizon-farm-test-q9")


def _run_guarded_suite(tmp_path, body, seed=()):
    """A throwaway pytest run with the real TmpLeakGuard over a fake temp root
    (tmp_path/"tmp"), sandboxed the way conftest.py sandboxes the real suite.
    `seed` names dirs already in the fake root before the run starts."""
    fake_tmp = tmp_path / "tmp"
    fake_tmp.mkdir()
    for name in seed:
        (fake_tmp / name).mkdir()
        (fake_tmp / name / "test.db").write_text("x")
    (tmp_path / "pytest.ini").write_text("[pytest]\n")
    (tmp_path / "conftest.py").write_text(
        textwrap.dedent(
            f"""
            import os
            import tempfile
            from pathlib import Path
            from farm.tests.tmp_guard import TmpLeakGuard

            REAL_TMP = {str(fake_tmp)!r}
            RUN_TMP = tempfile.mkdtemp(prefix=f"horizon-run-{{os.getpid()}}-", dir=REAL_TMP)
            os.environ["TMPDIR"] = RUN_TMP
            tempfile.tempdir = RUN_TMP

            def pytest_configure(config):
                config.pluginmanager.register(TmpLeakGuard(Path(REAL_TMP), Path(RUN_TMP)), "stub-tmp-guard")

            def pytest_unconfigure(config):
                try:
                    os.rmdir(RUN_TMP)
                except OSError:
                    pass
            """
        )
    )
    (tmp_path / "test_inner.py").write_text(
        "import tempfile\nfrom pathlib import Path\n\n\ndef test_inner():\n" + textwrap.indent(textwrap.dedent(body), "    ")
    )
    env = dict(os.environ, PYTHONPATH=str(REPO_ROOT))
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(tmp_path / "test_inner.py")],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return result, fake_tmp


def _leak_body(tmp_path):
    return f"""
    leaked = tempfile.mkdtemp(prefix="horizon-demo-")
    Path({str(tmp_path / "leaked-path")!r}).write_text(leaked)
    """


def test_a_leaky_run_fails_and_names_the_dir_it_left(tmp_path):
    result, _ = _run_guarded_suite(tmp_path, _leak_body(tmp_path))
    leaked = (tmp_path / "leaked-path").read_text()
    assert result.returncode == 1, result.stdout + result.stderr
    assert f"LEAKED temp entry (created by this run, left in place): {leaked}" in result.stdout
    # Named for the operator, never deleted.
    assert Path(leaked).is_dir()


def test_a_run_that_already_fails_still_names_its_leak(tmp_path):
    result, _ = _run_guarded_suite(tmp_path, _leak_body(tmp_path) + "assert False, 'inner failure'\n")
    leaked = (tmp_path / "leaked-path").read_text()
    assert result.returncode == 1, result.stdout + result.stderr
    assert "1 failed" in result.stdout
    assert f"LEAKED temp entry (created by this run, left in place): {leaked}" in result.stdout


def test_a_clean_run_passes(tmp_path):
    result, fake_tmp = _run_guarded_suite(tmp_path, "pass\n")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "LEAKED" not in result.stdout
    assert list(fake_tmp.iterdir()) == []


def test_another_runs_sandbox_is_never_a_leak(tmp_path):
    other = tmp_path / "tmp" / "horizon-run-99999-x"
    body = f"""
    other = Path({str(other)!r})
    other.mkdir()
    (other / "in-use.json").write_text("{{}}")
    """
    result, _ = _run_guarded_suite(tmp_path, body)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "horizon-run-99999-x" not in result.stdout
    assert (other / "in-use.json").exists()


def test_leftovers_already_there_at_start_are_ignored(tmp_path):
    result, fake_tmp = _run_guarded_suite(tmp_path, "pass\n", seed=INCIDENT_NAMES)
    assert result.returncode == 0, result.stdout + result.stderr
    for name in INCIDENT_NAMES:
        assert name not in result.stdout
        assert (fake_tmp / name / "test.db").exists()


def test_spawned_children_inherit_the_sandbox(request):
    guard = request.config.pluginmanager.get_plugin("hz238-tmp-leak-guard")
    child = subprocess.run(
        [sys.executable, "-c", "import tempfile; print(tempfile.gettempdir())"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert child.stdout.strip() == str(guard.sandbox)
    assert tempfile.gettempdir() == str(guard.sandbox)


def test_pytest_basetemp_stays_under_the_real_temp_root(request, tmp_path_factory):
    guard = request.config.pluginmanager.get_plugin("hz238-tmp-leak-guard")
    basetemp = tmp_path_factory.getbasetemp()
    assert basetemp.is_relative_to(guard.real_tmp / f"pytest-of-{getpass.getuser()}")
    assert not basetemp.is_relative_to(guard.sandbox)
