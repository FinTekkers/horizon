"""HZ-508: every publish to e2e-artifacts/<id> recomputes per-screen diffs.

These run the real farm/capture/diff.mjs (pixelmatch), so they need
`npm --prefix farm/capture install` first, which `npm test` does. Without it
they FAIL — publish_screenshots skips the diffs, and every case below expects
a results.json — rather than skip.
"""

import json
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import pytest

from farm import screenshot_runner, step_agent
from farm.step_agent import publish_screenshots

ITEM = {"id": "T-1", "repo": "acme/demo"}
REF = "e2e-artifacts/t-1"
TREE = "e2e/__screenshots__"
FIXTURE = Path(__file__).resolve().parents[2] / "domain" / "fixtures" / "screenshot-results.json"


def git(cwd, *args, **kw):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True, **kw).stdout


def png(width=20, height=20, changed=0) -> bytes:
    """A real RGBA PNG: opaque black, with the first `changed` pixels red."""
    rows = b""
    for y in range(height):
        row = bytearray(b"\0")
        for x in range(width):
            row += b"\xff\0\0\xff" if y * width + x < changed else b"\0\0\0\xff"
        rows += bytes(row)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def png_size(data: bytes) -> tuple[int, int]:
    return struct.unpack(">II", data[16:24])


def workspace(tmp_path):
    origin = tmp_path / "origin.git"
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-q", "-b", "main")
    git(seed, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "initial")
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(origin)], check=True, capture_output=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "-q", str(origin), str(ws)], check=True, capture_output=True)
    git(ws, "config", "user.email", "farm@example.com")
    git(ws, "config", "user.name", "Horizon Farm")
    return ws, origin


def seed_baseline(tmp_path, origin, shots: dict[str, bytes]) -> str:
    """Pushes an e2e-baseline holding `shots`, like promoteBaseline leaves it."""
    base = tmp_path / "baseline-seed"
    git(tmp_path, "init", "-q", "-b", "e2e-baseline", str(base))
    (base / TREE).mkdir(parents=True)
    for name, data in shots.items():
        (base / TREE / f"{name}.png").write_bytes(data)
    git(base, "add", "-A")
    git(base, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "baseline")
    git(base, "push", "-q", str(origin), "e2e-baseline")
    return origin_sha(origin, "e2e-baseline")


def origin_sha(origin, ref):
    proc = subprocess.run(["git", "--git-dir", str(origin), "rev-parse", "--verify", "-q", ref], capture_output=True, text=True)
    return proc.stdout.strip() or None


def write_shots(ws, shots: dict[str, bytes]):
    d = ws / TREE
    if d.exists():
        for old in d.glob("*.png"):
            old.unlink()
    d.mkdir(parents=True, exist_ok=True)
    for name, data in shots.items():
        (d / f"{name}.png").write_bytes(data)


def ref_files(origin, ref=REF) -> list[str]:
    return subprocess.run(
        ["git", "--git-dir", str(origin), "ls-tree", "-r", "--name-only", ref], capture_output=True, text=True, check=True
    ).stdout.split()


def diff_files(origin) -> set[str]:
    return {f for f in ref_files(origin) if f.startswith(f"{TREE}/diff/")}


def results(origin) -> dict:
    out = subprocess.run(
        ["git", "--git-dir", str(origin), "show", f"{REF}:{TREE}/results.json"], capture_output=True, text=True, check=True
    ).stdout
    return json.loads(out)


def statuses(doc) -> dict[str, str]:
    return {shot["name"]: shot["status"] for shot in doc["shots"]}


def publish(ws, lines=None):
    publish_screenshots(ws, ITEM, log=(lines.append if lines is not None else lambda *_: None))


def test_a_second_publish_leaves_only_its_own_results(tmp_path):
    # Metric 1: nothing of publish 1 — its result rows, its diff PNG, its b.png — survives publish 2.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"a": png()})
    write_shots(ws, {"a": png(changed=200), "b": png()})
    publish(ws)
    assert statuses(results(origin)) == {"a": "changed", "b": "new"}
    assert diff_files(origin) == {f"{TREE}/diff/a.png"}

    write_shots(ws, {"c": png()})
    publish(ws)

    assert [(s["name"], s["status"]) for s in results(origin)["shots"]] == [("a", "removed"), ("c", "new")]
    files = ref_files(origin)
    assert not [f for f in files if f.startswith(f"{TREE}/diff/")]
    assert f"{TREE}/b.png" not in files


def test_each_changed_shot_has_exactly_one_diff_png(tmp_path):
    # Metric 2: the diff/ set is exactly the changed-and-computed shots, and every `diff` path resolves.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"a": png(), "b": png(), "c": png(), "d": png(changed=1)})
    write_shots(ws, {"a": png(changed=100), "b": png(changed=300), "c": png(), "d": png()})
    publish(ws)

    doc = results(origin)
    changed = {s["name"] for s in doc["shots"] if s["status"] == "changed" and s["error"] is None}
    assert changed == {"a", "b"}
    assert diff_files(origin) == {f"{TREE}/diff/{name}.png" for name in changed}
    for shot in doc["shots"]:
        if shot["diff"] is not None:
            subprocess.run(["git", "--git-dir", str(origin), "cat-file", "-e", f"{REF}:{shot['diff']}"], check=True)
    assert {s["name"]: s["diff"] for s in doc["shots"]} == {
        "a": f"{TREE}/diff/a.png",
        "b": f"{TREE}/diff/b.png",
        "c": None,
        "d": None,
    }


def test_shots_of_different_sizes_get_one_padded_diff_png(tmp_path):
    # Metric 2: a size change is `changed` (ratio 1) with one diff PNG on the larger canvas.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"a": png(20, 20)})
    write_shots(ws, {"a": png(20, 30)})
    publish(ws)

    [shot] = results(origin)["shots"]
    assert (shot["status"], shot["diffRatio"], shot["error"]) == ("changed", 1, None)
    assert diff_files(origin) == {f"{TREE}/diff/a.png"}
    data = subprocess.run(
        ["git", "--git-dir", str(origin), "show", f"{REF}:{TREE}/diff/a.png"], capture_output=True, check=True
    ).stdout
    assert png_size(data) == (20, 30)


def test_new_and_removed_shots_get_no_diff_png(tmp_path):
    # Metric 3.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"old": png()})
    write_shots(ws, {"fresh": png(changed=50)})
    publish(ws)

    doc = results(origin)
    assert statuses(doc) == {"fresh": "new", "old": "removed"}
    assert all(s["diff"] is None for s in doc["shots"])
    assert diff_files(origin) == set()


def test_without_a_baseline_ref_every_shot_is_new(tmp_path):
    # Metric 3, and the baseline stays read-only even when it is missing.
    ws, origin = workspace(tmp_path)
    write_shots(ws, {"a": png(), "b": png(changed=5)})
    publish(ws)

    doc = results(origin)
    assert doc["baseline"] is None
    assert statuses(doc) == {"a": "new", "b": "new"}
    assert diff_files(origin) == set()
    assert origin_sha(origin, "e2e-baseline") is None


def test_stray_pixels_within_tolerance_are_same(tmp_path):
    # Metric 4: 2 of 400 pixels (0.5%) differ.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"a": png()})
    write_shots(ws, {"a": png(changed=2)})
    publish(ws)

    [shot] = results(origin)["shots"]
    assert (shot["status"], shot["diffRatio"], shot["diff"]) == ("same", 0.005, None)
    assert diff_files(origin) == set()


def test_a_ratio_exactly_at_the_tolerance_is_same(tmp_path):
    # Metric 4: "within" includes the boundary — 4 of 400 pixels is exactly 0.01.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"a": png()})
    write_shots(ws, {"a": png(changed=4)})
    publish(ws)

    [shot] = results(origin)["shots"]
    assert shot["diffRatio"] == 0.01
    assert (shot["status"], shot["diff"]) == ("same", None)
    assert diff_files(origin) == set()


def test_written_results_match_the_shared_fixture_contract(tmp_path):
    # Metric 5: the server renders domain/fixtures/screenshot-results.json, so what the farm writes must share its shape.
    fixture = json.loads(FIXTURE.read_text())
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"board": png(), "broken": png(), "home": png(), "old": png()})
    write_shots(ws, {"board": png(changed=100), "broken": b"\x89PNG\r\n\x1a\nnot really", "gates": png(), "home": png(changed=2)})
    publish(ws)

    doc = results(origin)
    assert set(doc) == set(fixture)
    for key in fixture:
        if key != "baseline":
            assert type(doc[key]) is type(fixture[key]), key
    assert isinstance(doc["baseline"], str)
    by_name = {s["name"]: s for s in doc["shots"]}
    assert sorted(by_name) == sorted(s["name"] for s in fixture["shots"])
    for expected in fixture["shots"]:
        got = by_name[expected["name"]]
        assert set(got) == set(expected), expected["name"]
        assert got["status"] == expected["status"], expected["name"]
        for key in ("diff", "error"):
            assert (got[key] is None) == (expected[key] is None), (expected["name"], key)
        assert (got["diffRatio"] is None) == (expected["diffRatio"] is None), expected["name"]


def test_default_thresholds_are_recorded_and_a_config_can_override_them(tmp_path):
    # Guardrail 1: 0.1 / 0.01 unless .horizon/screenshots.json says otherwise.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"home--desktop--light": png()})
    write_shots(ws, {"home--desktop--light": png(changed=2)})
    publish(ws)
    doc = results(origin)
    assert (doc["threshold"], doc["ratioTolerance"]) == (0.1, 0.01)
    assert statuses(doc) == {"home--desktop--light": "same"}

    (ws / ".horizon").mkdir()
    config = json.loads((Path(__file__).parent / "fixtures" / "screenshots" / "valid.json").read_text())
    config["outputDir"] = TREE
    config["diff"] = {"ratioTolerance": 0}
    (ws / ".horizon" / "screenshots.json").write_text(json.dumps(config))
    publish(ws)
    doc = results(origin)
    assert (doc["threshold"], doc["ratioTolerance"]) == (0.1, 0)
    assert statuses(doc) == {"home--desktop--light": "changed"}
    assert diff_files(origin) == {f"{TREE}/diff/home--desktop--light.png"}


def _exits_1(monkeypatch, tmp_path):
    monkeypatch.setattr(step_agent, "DIFF_CMD", [sys.executable, "-c", "import sys; sys.exit(1)"])


def _hangs(monkeypatch, tmp_path):
    monkeypatch.setattr(step_agent, "DIFF_TIMEOUT_S", 1)
    monkeypatch.setattr(step_agent, "DIFF_CMD", [sys.executable, "-c", "import time; time.sleep(30)"])


def _writes(text):
    """A helper that exits 0 but writes `text` as its result file."""
    script = f"import json, pathlib, sys; pathlib.Path(json.load(sys.stdin)['resultFile']).write_text({text!r})"

    def apply(monkeypatch, tmp_path):
        monkeypatch.setattr(step_agent, "DIFF_CMD", [sys.executable, "-c", script])

    return apply


def _writes_nothing(monkeypatch, tmp_path):
    monkeypatch.setattr(step_agent, "DIFF_CMD", [sys.executable, "-c", "print('{}')"])


def _deps_missing(monkeypatch, tmp_path):
    empty = tmp_path / "capture"
    empty.mkdir()
    monkeypatch.setattr(screenshot_runner, "CAPTURE_DIR", empty)


@pytest.mark.parametrize(
    "breaks",
    [
        _exits_1,
        _hangs,
        _writes("not json"),
        _writes(json.dumps({"shots": [{"name": "zzz", "status": "same", "diffRatio": 0, "error": None}]})),
        _writes(json.dumps({"shots": [{"name": "a", "status": "bogus", "diffRatio": 0, "error": None}]})),
        _writes_nothing,
        _deps_missing,
    ],
    ids=["exits-1", "hangs", "bad-json", "unknown-name", "unknown-status", "no-result-file", "deps-missing"],
)
def test_a_failed_diff_step_still_pushes_the_shots(tmp_path, monkeypatch, breaks):
    # Guardrail 2: best-effort — the shots publish, results.json does not, nothing raises.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"a": png()})
    write_shots(ws, {"a": png(changed=200)})
    breaks(monkeypatch, tmp_path)
    lines: list[str] = []

    publish(ws, lines)

    assert ref_files(origin) == [f"{TREE}/a.png"]
    assert any(line.startswith("publish_screenshots: diffs skipped — ") for line in lines), lines
    assert lines[-1] == f"publish_screenshots: pushed 1 screenshot(s) to {REF}"


def test_a_corrupt_shot_is_changed_with_an_error_and_the_rest_still_diff(tmp_path):
    # Guardrail 2, per shot: the one PNG that cannot be read has no diff; the other still gets one.
    ws, origin = workspace(tmp_path)
    seed_baseline(tmp_path, origin, {"a": png(), "b": png()})
    write_shots(ws, {"a": b"\x89PNG\r\n\x1a\ngarbage", "b": png(changed=200)})
    publish(ws)

    by_name = {s["name"]: s for s in results(origin)["shots"]}
    assert by_name["a"]["status"] == "changed"
    assert by_name["a"]["error"]
    assert (by_name["a"]["diff"], by_name["a"]["diffRatio"]) == (None, None)
    assert (by_name["b"]["status"], by_name["b"]["error"]) == ("changed", None)
    assert diff_files(origin) == {f"{TREE}/diff/b.png"}


def test_publish_never_moves_the_baseline(tmp_path):
    # Guardrail 3: e2e-baseline is fetched, never pushed.
    ws, origin = workspace(tmp_path)
    before = seed_baseline(tmp_path, origin, {"a": png(), "b": png()})
    write_shots(ws, {"a": png(changed=200), "c": png()})
    publish(ws)
    write_shots(ws, {"b": png(changed=200)})
    publish(ws)
    assert origin_sha(origin, "e2e-baseline") == before
    assert ref_files(origin, "e2e-baseline") == [f"{TREE}/a.png", f"{TREE}/b.png"]


HORIZON_CONFIG = Path(__file__).resolve().parents[2] / ".horizon" / "screenshots.json"


def write_horizon_config_shots(ws) -> dict[str, bytes]:
    """Horizon's own .horizon/screenshots.json, plus one PNG per shot in its
    outputDir, named as the runner names them."""
    (ws / ".horizon").mkdir()
    (ws / ".horizon" / "screenshots.json").write_text(HORIZON_CONFIG.read_text())
    cfg = step_agent.screenshots_config.load_config(ws)
    out = ws / cfg.output_dir
    out.mkdir(parents=True)
    taken, shots = set(), {}
    for shot in cfg.shots:
        name = screenshot_runner.png_name(shot, taken)
        (out / name).write_bytes(png())
        shots[name[: -len(".png")]] = png()
    (out / screenshot_runner.MANIFEST_NAME).write_text('{"version": 1, "shots": []}')
    return shots


def test_adding_the_config_keeps_publishing_every_journey_shot(tmp_path):
    # HZ-512 metric 4: the journey shots on e2e-baseline still publish beside
    # the config's shots, so none reads `removed`; the config's read `new`.
    ws, origin = workspace(tmp_path)
    journeys = {"board-blocked-dark": png(), "mobile-layout": png()}
    seed_baseline(tmp_path, origin, journeys)
    write_shots(ws, journeys)
    config_shots = write_horizon_config_shots(ws)
    assert config_shots and not set(config_shots) & set(journeys)

    publish(ws)

    got = statuses(results(origin))
    assert "removed" not in got.values(), got
    assert got == {**{name: "same" for name in journeys}, **{name: "new" for name in config_shots}}
    files = ref_files(origin)
    assert {f"{TREE}/{name}.png" for name in [*journeys, *config_shots]} <= set(files)
    assert f"{TREE}/{screenshot_runner.MANIFEST_NAME}" in files


def test_a_config_shot_wins_over_a_journey_shot_of_the_same_name(tmp_path):
    ws, origin = workspace(tmp_path)
    config_shots = write_horizon_config_shots(ws)
    name = next(iter(config_shots))
    write_shots(ws, {name: png(changed=5), "journey": png()})

    publish(ws)

    shown = subprocess.run(
        ["git", "--git-dir", str(origin), "show", f"{REF}:{TREE}/{name}.png"], capture_output=True, check=True
    ).stdout
    assert shown == png()
    assert f"{TREE}/journey.png" in ref_files(origin)
