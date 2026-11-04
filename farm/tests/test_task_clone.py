"""HZ-738: the task clone's lock and a read-only step's refresh.

Execute holds clone_lock shared for its whole run; a step's refresh takes it
exclusively, only for the fast-forward, and fails with CloneBusy rather than
move HEAD under a live job. Real git and real flocks throughout.
"""

import os
import stat
import threading

import pytest

from farm import task_clone, task_job
from farm.tests.test_task_job import _git, _origin_and_clone, _origin_main, _push_commit, _wait_for, plan_artifact

FORBID = str(task_job.HORIZON_ROOT)


def test_refresh_fast_forwards_and_leaves_a_readable_lock_file_inside_git(tmp_path):
    _upstream, clone = _origin_and_clone(tmp_path)
    sha = task_clone.refresh(str(clone), forbid=FORBID, wait_s=0.2)
    assert sha == _origin_main(clone) == _git(clone, "rev-parse", "HEAD")
    lock = clone / ".git" / task_clone.LOCK_NAME
    assert lock.is_file()
    # Readable by any run user: flock needs only a read-only open.
    assert stat.S_IMODE(lock.stat().st_mode) & stat.S_IRUSR
    assert os.access(lock, os.R_OK)
    assert _git(clone, "status", "--porcelain") == ""


def test_two_shared_holders_never_block_each_other(tmp_path):
    """Guardrail 3: concurrent Executes in one clone run as before."""
    _upstream, clone = _origin_and_clone(tmp_path)
    with task_clone.clone_lock(str(clone), shared=True):
        both = threading.Event()

        def second():
            with task_clone.clone_lock(str(clone), shared=True):
                both.set()

        thread = threading.Thread(target=second)
        thread.start()
        thread.join(timeout=10)
        assert both.is_set(), "a second shared holder waited on the first"


def test_a_held_shared_lock_makes_refresh_busy_and_moves_nothing(tmp_path):
    _upstream, clone = _origin_and_clone(tmp_path)
    before = _git(clone, "rev-parse", "HEAD")
    with task_clone.clone_lock(str(clone), shared=True):
        with pytest.raises(task_clone.CloneBusy) as err:
            task_clone.refresh(str(clone), forbid=FORBID, wait_s=0.2)
    assert str(err.value) == task_clone.BUSY
    assert _git(clone, "rev-parse", "HEAD") == before
    assert before != _origin_main(clone)


def test_a_clone_without_git_refuses_the_lock(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(task_clone.CloneRefused, match="task clone lock unavailable"):
        with task_clone.clone_lock(str(plain), shared=False):
            pass


def test_the_shared_lock_spans_a_real_execute_run(tmp_path):
    """Guardrail 4: while a real run_job's command runs, a step's refresh is
    CloneBusy and HEAD stays put; once released, the job finishes normally."""
    upstream, clone = _origin_and_clone(tmp_path)
    started, release = tmp_path / "started", tmp_path / "release"
    command = f"touch {started}; while [ ! -e {release} ]; do sleep 0.05; done"
    artifact = plan_artifact(".", [command], runner="host")
    result = {}

    def run():
        result["summary"] = task_job.run_job(
            run_id=738,
            item_id="HZ-738",
            plan_artifact=artifact,
            approved_hash=task_job.plan_hash_of(artifact),
            runner="host",
            state_path=tmp_path / "job.json",
            log_path=tmp_path / "job.log",
            repo_dir=str(clone),
            task_clone=True,
        )

    thread = threading.Thread(target=run)
    thread.start()
    try:
        _wait_for(started.exists, "the job's command to start")
        ran_on = _git(clone, "rev-parse", "HEAD")
        _push_commit(upstream, "three.txt")
        with pytest.raises(task_clone.CloneBusy):
            task_clone.refresh(str(clone), forbid=FORBID, wait_s=0.2)
        assert _git(clone, "rev-parse", "HEAD") == ran_on
    finally:
        release.touch()
        thread.join(timeout=30)
    assert result["summary"] == {"run": 1, "passed": 1, "failed": 0, "failing": []}
    # Released: the next step's refresh goes through.
    assert task_clone.refresh(str(clone), forbid=FORBID, wait_s=0.2) == _origin_main(clone)


def test_execute_waits_for_a_refresh_then_runs(tmp_path):
    """Execute waits only while a step's fast-forward holds the lock."""
    _upstream, clone = _origin_and_clone(tmp_path)
    artifact = plan_artifact(".", ["true"], runner="host")
    result = {}
    with task_clone.clone_lock(str(clone), shared=False):
        thread = threading.Thread(
            target=lambda: result.setdefault(
                "summary",
                task_job.run_job(
                    run_id=739,
                    item_id="HZ-739",
                    plan_artifact=artifact,
                    approved_hash=task_job.plan_hash_of(artifact),
                    runner="host",
                    state_path=tmp_path / "job.json",
                    log_path=tmp_path / "job.log",
                    repo_dir=str(clone),
                    task_clone=True,
                ),
            )
        )
        thread.start()
        thread.join(timeout=0.3)
        assert thread.is_alive() and "summary" not in result
    thread.join(timeout=30)
    assert result["summary"] == {"run": 1, "passed": 1, "failed": 0, "failing": []}
