# HZ-124's real merge conflict, vendored

The three sides of the conflict named in HZ-154's success metric: commit
`ce379a3` (HZ-124's PR branch) merged with `origin/main` at `85cf212`, whose
merge base is `4dc6aa0`.

| file | commit | as it was in |
| --- | --- | --- |
| `<name>.base.txt` | `4dc6aa0` | the merge base |
| `<name>.ours.txt` | `ce379a3` | the PR branch |
| `<name>.theirs.txt` | `85cf212` | `main` |

`<name>` is `claude` for `farm/providers/claude.py` and `muse` for
`farm/providers/muse.py` — the two files that actually conflicted. Each is the
whole file, byte-for-byte, so replaying them reproduces git's own conflict
rather than a miniature of it.

`.txt`, not `.py`, deliberately: these are inert test data, not importable
modules, and nothing should collect or lint them as source.

They are vendored so the replay in `farm/tests/test_conflict_scoped.py` runs
everywhere. `ce379a3` is a PR-branch commit and is unreachable from `main`, so
a fresh or shallow clone will not have it — the replay would otherwise skip in
exactly the environment (CI) where it is the acceptance evidence. When the two
commits ARE present, the same test additionally asserts these files still match
them byte-for-byte, so an edited fixture fails loudly instead of quietly
replaying something else.
