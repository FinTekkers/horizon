"""HO-877: the server pins an sl item to the diff it stored at submit
(work_item.diff_id) and names it on /vcs/review-status and /vcs/land. A
checkout carrying any other diff is refused 409 diff_mismatch with zero
`sl push`, counted through FakeSl (farm/tests/sl_fake.py).
"""

from farm.tests.test_farmd_vcs import body, fake, farm_running, green_checks, loopback  # noqa: F401 — fixtures
from farm.vcs import sl

REPO = "fbsource"
ITEM_ID = "HO-876"


def submitted(fake, accepted=True):
    ws = sl.checkout(REPO, ITEM_ID)
    fake.edit(ws)
    res = loopback().post("/vcs/submit", json=body())
    assert res.status_code == 200, res.text
    assert res.json()["diff"] == "D1"
    if accepted:
        fake.set_status("D1", "Accepted")
    return ws


def test_land_with_another_diff_is_refused_and_pushes_nothing(fake, green_checks):
    submitted(fake)

    res = loopback().post("/vcs/land", json=body(diff="D2", check_commands={"test": "true"}))

    assert res.status_code == 409, res.text
    assert res.json()["error"] == "diff_mismatch"
    assert res.json()["expected"] == "D2" and res.json()["found"] == "D1"
    assert fake.count("sl", "push") == 0
    assert fake.count("jf", "sync") == 0
    assert green_checks == []
    assert fake.git_or_gh() == []


def test_land_with_the_pinned_diff_lands_once(fake, green_checks):
    submitted(fake)

    res = loopback().post("/vcs/land", json=body(diff="D1", check_commands={"test": "true"}))

    assert res.status_code == 200, res.text
    assert res.json()["diff"] == "D1" and res.json()["already_landed"] is False
    assert fake.count("sl", "push") == 1


def test_review_status_with_another_diff_is_refused(fake):
    submitted(fake, accepted=False)

    res = loopback().post("/vcs/review-status", json=body(diff="D9"))
    assert res.status_code == 409, res.text
    assert res.json()["error"] == "diff_mismatch" and res.json()["found"] == "D1"

    res = loopback().post("/vcs/review-status", json=body(diff="D1"))
    assert res.status_code == 200, res.text
    assert res.json() == {"diff": "D1", "status": "Needs Review", "landed_commit": None}


def test_a_malformed_diff_is_400_with_zero_spawns(fake):
    submitted(fake)
    before = len(fake.calls)
    for route in ("/vcs/review-status", "/vcs/land"):
        for bad in ("1", "D", "D1 ", "d1", 7, ["D1"]):
            res = loopback().post(route, json=body(diff=bad))
            assert res.status_code == 400, (route, bad, res.text)
            assert res.json()["error"] == "bad_diff"
    assert len(fake.calls) == before
    assert fake.count("sl", "push") == 0
