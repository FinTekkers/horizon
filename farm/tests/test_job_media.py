"""HZ-815: a Task's declared `outputs` media — copied after Execute into the
item's own store with its MIME type and size, and only from the run's
allowed roots, under the per-file and per-item caps. Real runs through
task_job.run_job where the path matters; collect_media directly for the caps.
"""

import json
import re
from pathlib import Path

import pytest

from domain.py import run_plan
from farm import config, farmd, job_media, task_job

FAKE_IMAGE = "localhost/horizon-task:fake"
TASK_MEDIA = json.loads((Path(__file__).resolve().parents[2] / "domain" / "taskMedia.json").read_text())
# The server's GET /api/items/:id/media/:name name check, read from the same file.
SERVED_NAME = re.compile(TASK_MEDIA["storedName"])
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + bytes(range(256)) * 4
JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + bytes(range(256)) * 2


def plan_with(outputs, commands=("true",)):
    block = {"cwd": ".", "commands": list(commands), "budget_minutes": 1}
    if outputs is not None:
        block["outputs"] = outputs
    return "## Commands\nA plan.\n\n## Run plan block\n" + run_plan.render(block) + "\n"


def run(tmp_path, artifact, *, runner="host", state_path=None, media_roots=(), repo=None):
    repo = repo or tmp_path / "repo"
    state_path = state_path or tmp_path / "run" / "HZ-1.json"
    task_job.run_job(
        run_id=7,
        item_id="HZ-1",
        plan_artifact=artifact,
        approved_hash=task_job.plan_hash_of(artifact),
        runner=runner,
        state_path=state_path,
        log_path=state_path.with_suffix(".log"),
        repo_dir=str(repo),
        container_image=FAKE_IMAGE,
        env_values={},
        media_roots=media_roots,
    )
    return task_job.load_state(state_path), job_media.media_dir_for(state_path, "HZ-1")


@pytest.fixture
def repo(tmp_path):
    out = tmp_path / "repo" / "out"
    out.mkdir(parents=True)
    (out / "cut.mp4").write_bytes(MP4)
    (out / "poster.jpg").write_bytes(JPG)
    return tmp_path / "repo"


def by_path(media):
    return {entry["path"]: entry for entry in media}


# ---- metric 1: stored with the right MIME type and size; outside refused ----


def test_a_task_stores_its_declared_mp4_and_jpg_with_mime_and_byte_size(tmp_path, repo):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "leak.jpg").write_bytes(JPG)
    state, media_dir = run(
        tmp_path,
        plan_with(
            [
                {"path": "out/cut.mp4", "kind": "video"},
                {"path": "out/poster.jpg", "kind": "image"},
                {"path": "/etc/passwd", "kind": "image"},
                {"path": str(outside / "leak.jpg"), "kind": "image"},
            ]
        ),
    )
    media = by_path(state["media"])
    mp4, jpg = media["out/cut.mp4"], media["out/poster.jpg"]
    assert (mp4["status"], mp4["mime"], mp4["bytes"], mp4["name"]) == ("stored", "video/mp4", len(MP4), "cut.mp4")
    assert (jpg["status"], jpg["mime"], jpg["bytes"], jpg["name"]) == ("stored", "image/jpeg", len(JPG), "poster.jpg")
    assert (media_dir / "cut.mp4").read_bytes() == MP4
    assert (media_dir / "poster.jpg").read_bytes() == JPG
    # Outside the allowed roots: listed, never copied.
    for path in ("/etc/passwd", str(outside / "leak.jpg")):
        assert media[path]["status"] == "refused"
        assert not (media_dir / media[path]["name"]).exists()
    assert "outside the run's checkout" in media[str(outside / "leak.jpg")]["reason"]
    # The run's report — the Execute artifact's Outputs section — names them.
    report = job_media.outputs_md(state["media"])
    assert report.startswith(job_media.OUTPUTS_HEADING)
    assert "`/etc/passwd`" in report and f"`{outside / 'leak.jpg'}`" in report
    assert sorted(e["name"] for e in job_media.read_manifest(media_dir) if e["status"] == "stored") == ["cut.mp4", "poster.jpg"]


def test_the_outputs_section_sits_in_the_execute_artifact(tmp_path, repo):
    state, _ = run(tmp_path, plan_with([{"path": "out/cut.mp4", "kind": "video"}, {"path": "/etc/passwd", "kind": "image"}]))
    artifact = farmd.job_artifact_md(
        "1 command(s) run", "log", commands=["$ true"], outputs_md=job_media.outputs_md(state["media"])
    )
    assert "## Outputs\n- `cut.mp4` (`out/cut.mp4`)" in artifact
    assert "`/etc/passwd`) — image, 0 B — refused:" in artifact


# ---- guardrail 1: only declared files, realpath under the allowed roots ----


def test_a_symlink_in_the_checkout_that_points_outside_is_refused(tmp_path, repo):
    secret = tmp_path / "secret.jpg"
    secret.write_bytes(JPG)
    (repo / "out" / "link.jpg").symlink_to(secret)
    state, media_dir = run(tmp_path, plan_with([{"path": "out/link.jpg", "kind": "image"}]))
    (entry,) = state["media"]
    assert entry["status"] == "refused"
    assert "outside" in entry["reason"]
    assert not (media_dir / entry["name"]).exists()


def test_a_declared_directory_is_refused_and_nothing_under_it_is_copied_or_listed(tmp_path, repo):
    frames = repo / "out" / "frames.png"
    frames.mkdir()
    (frames / "f1.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 10)
    state, media_dir = run(tmp_path, plan_with([{"path": "out/frames.png", "kind": "image"}]))
    (entry,) = state["media"]
    assert (entry["status"], entry["reason"]) == ("refused", "not a regular file")
    assert sorted(p.name for p in media_dir.iterdir()) == ["manifest.json"]
    assert "f1.png" not in json.dumps(state["media"])


def test_a_missing_file_is_listed_missing(tmp_path, repo):
    state, _ = run(tmp_path, plan_with([{"path": "out/never.mp4", "kind": "video"}]))
    assert [(e["status"], e["reason"]) for e in state["media"]] == [("missing", "no such file")]


def test_a_host_run_may_read_media_output_roots(tmp_path, repo):
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    (recordings / "ch1.mp4").write_bytes(MP4)
    state, media_dir = run(
        tmp_path, plan_with([{"path": str(recordings / "ch1.mp4"), "kind": "video"}]), media_roots=(str(recordings),)
    )
    assert [e["status"] for e in state["media"]] == ["stored"]
    assert (media_dir / "ch1.mp4").read_bytes() == MP4


def test_a_container_run_cannot_reach_media_output_roots(tmp_path, repo):
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    (recordings / "ch1.mp4").write_bytes(MP4)
    state, media_dir = run(
        tmp_path,
        plan_with([{"path": str(recordings / "ch1.mp4"), "kind": "video"}]),
        runner="container",
        media_roots=(str(recordings),),
    )
    # pytest's tmp_path is under /tmp, which a container run looks up in its
    # own /tmp dir instead: there the file is not found. Either way, unstored.
    assert [e["status"] for e in state["media"]] in (["refused"], ["missing"])
    assert not (media_dir / "ch1.mp4").exists()


def test_only_a_farm_host_run_is_offered_media_output_roots(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(job_media, "collect_media", lambda *a, **kw: seen.append(kw["extra_roots"]) or [])
    monkeypatch.setattr(config, "TENANT_JOBS_DIR", tmp_path / "tenant-jobs")
    roots = ("/home/farm/recordings",)
    outputs = [{"path": "x.mp4", "kind": "video"}]
    task_job._collect_media(outputs, "/r", "/r", tmp_path / "s" / "HZ-1.json", "HZ-1", {}, roots, None)
    task_job._collect_media(outputs, "/r", "/r", tmp_path / "s" / "HZ-1.json", "HZ-1", {}, roots, tmp_path / "tmp")
    task_job._collect_media(outputs, "/r", "/r", tmp_path / "tenant-jobs" / "4" / "HZ-1.json", "HZ-1", {}, roots, None)
    assert seen == [roots, (), ()]


def test_a_tenant_run_cannot_reach_media_output_roots(tmp_path, repo, monkeypatch):
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    (recordings / "ch1.mp4").write_bytes(MP4)
    tenant_jobs = tmp_path / "tenant-jobs"
    monkeypatch.setattr(config, "TENANT_JOBS_DIR", tenant_jobs)
    state_path = tenant_jobs / "42" / "HZ-1.json"
    state, media_dir = run(
        tmp_path,
        plan_with([{"path": str(recordings / "ch1.mp4"), "kind": "video"}, {"path": "out/poster.jpg", "kind": "image"}]),
        state_path=state_path,
        media_roots=(str(recordings),),
    )
    assert [e["status"] for e in state["media"]] == ["refused", "stored"]
    assert media_dir == tenant_jobs / "42" / "media" / "HZ-1"
    assert not (media_dir / "ch1.mp4").exists()
    assert oct((media_dir / "poster.jpg").stat().st_mode & 0o777) == oct(0o640)


def test_a_file_whose_bytes_are_not_its_type_is_refused(tmp_path, repo):
    (repo / "out" / "fake.mp4").write_bytes(b"<html>not a video</html>")
    state, media_dir = run(tmp_path, plan_with([{"path": "out/fake.mp4", "kind": "video"}]))
    (entry,) = state["media"]
    assert entry["status"] == "refused"
    assert not (media_dir / "fake.mp4").exists()


# ---- guardrail 3: the per-file and per-item caps ----


def collect(repo, media_dir, outputs):
    return job_media.collect_media(outputs, str(repo), str(repo), media_dir, {}, forbid=None)


def test_a_file_over_the_per_file_cap_is_listed_with_name_and_size_but_not_stored(tmp_path, repo, monkeypatch):
    monkeypatch.setattr(job_media, "MEDIA_FILE_MAX_BYTES", len(MP4) - 1)
    media_dir = tmp_path / "media"
    (entry,) = collect(repo, media_dir, [{"path": "out/cut.mp4", "kind": "video"}])
    assert (entry["status"], entry["name"], entry["bytes"]) == ("over_cap", "cut.mp4", len(MP4))
    assert "per-file cap" in entry["reason"]
    assert not (media_dir / "cut.mp4").exists()
    assert "`cut.mp4`" in job_media.outputs_md([entry]) and "over_cap" in job_media.outputs_md([entry])


def test_the_file_that_crosses_the_per_item_cap_is_listed_but_not_stored(tmp_path, repo, monkeypatch):
    (repo / "out" / "second.mp4").write_bytes(MP4)
    monkeypatch.setattr(job_media, "MEDIA_ITEM_MAX_BYTES", len(MP4) + len(JPG))
    media_dir = tmp_path / "media"
    entries = collect(
        repo,
        media_dir,
        [{"path": "out/cut.mp4", "kind": "video"}, {"path": "out/second.mp4", "kind": "video"}, {"path": "out/poster.jpg", "kind": "image"}],
    )
    assert [(e["name"], e["status"], e["bytes"]) for e in entries] == [
        ("cut.mp4", "stored", len(MP4)),
        ("second.mp4", "over_cap", len(MP4)),
        ("poster.jpg", "stored", len(JPG)),
    ]
    assert "per-item cap" in entries[1]["reason"]
    assert not (media_dir / "second.mp4").exists()


def test_a_retry_removes_the_previous_runs_media(tmp_path, repo):
    media_dir = tmp_path / "media"
    collect(repo, media_dir, [{"path": "out/cut.mp4", "kind": "video"}, {"path": "out/poster.jpg", "kind": "image"}])
    assert (media_dir / "cut.mp4").exists()
    collect(repo, media_dir, [{"path": "out/poster.jpg", "kind": "image"}])
    assert not (media_dir / "cut.mp4").exists()
    assert [e["name"] for e in job_media.read_manifest(media_dir)] == ["poster.jpg"]
    assert job_media.stored_file(media_dir, "cut.mp4") is None


# ---- R3: every stored name is one the server's route serves ----


def test_stored_names_always_match_the_servers_name_rule_and_clashes_get_a_prefix(tmp_path):
    repo = tmp_path / "repo"
    names = ["_x.mp4", ".hidden.jpg", "a b.mp4", "ü.png", "n" * 240 + ".mp4", "a/cut.mp4", "b/cut.mp4", "manifest.json"]
    for name in names:
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    entries = collect(repo, tmp_path / "media", [{"path": n, "kind": "video"} for n in names])
    stored = [e["name"] for e in entries]
    for name in stored:
        assert SERVED_NAME.fullmatch(name), name
    assert stored[:4] == ["x.mp4", "hidden.jpg", "a-b.mp4", "file.png"]
    assert len(stored[4]) <= 200 and stored[4].endswith(".mp4")
    assert stored[5:7] == ["cut.mp4", "2-cut.mp4"]
    assert stored[7] == "2-manifest.json"
    assert len(set(stored)) == len(stored)


# ---- guardrail 4: no `outputs`, exactly as today ----


def test_a_plan_with_no_outputs_writes_no_media_key_and_no_media_dir(tmp_path, repo):
    state, media_dir = run(tmp_path, plan_with(None))
    assert state["status"] == "finished"
    assert "media" not in state
    assert not media_dir.parent.exists()


def test_no_outputs_leaves_the_execute_artifact_byte_identical():
    args = ("2 command(s) run, 2 passed, 0 failed", "log line\n")
    kwargs = {"commands": ["$ a", "$ b"], "reports_md": "## Reports\nr\n", "full_log": "Full log: x", "db_changes_md": "## Database changes\nt\n"}
    assert farmd.job_artifact_md(*args, **kwargs, outputs_md=job_media.outputs_md(None)) == farmd.job_artifact_md(*args, **kwargs)
    assert job_media.outputs_md([]) == ""


def test_ffprobe_missing_leaves_duration_and_dimensions_null(tmp_path, repo, monkeypatch):
    monkeypatch.setattr(job_media.shutil, "which", lambda name: None)
    (entry,) = collect(repo, tmp_path / "media", [{"path": "out/cut.mp4", "kind": "video"}])
    assert entry["status"] == "stored"
    assert (entry["durationS"], entry["width"], entry["height"]) == (None, None, None)


def test_the_view_carries_media_only_when_the_run_stored_some(tmp_path, monkeypatch):
    state_path = tmp_path / "HZ-1.json"
    monkeypatch.setattr(farmd, "_job_paths", lambda run_id, task: (state_path, tmp_path / "HZ-1.log"))
    monkeypatch.setattr(farmd, "_job_secrets", lambda task: {})
    task = {"item": {"id": "HZ-1"}, "plan_artifact": ""}
    task_job.save_state(state_path, {"run_id": 7, "status": "finished", "commands": []})
    assert "media" not in farmd._job_view("7", task)
    entry = {"name": "cut.mp4", "status": "stored", "bytes": 3}
    task_job.save_state(state_path, {"run_id": 7, "status": "finished", "commands": [], "media": [entry]})
    assert farmd._job_view("7", task)["media"] == [entry]
