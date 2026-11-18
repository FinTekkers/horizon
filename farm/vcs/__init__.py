"""Version-control backends (HO-874): one module per backend, the same shape
as farm/providers/. Every farm `git` spawn lives in farm/vcs/git.py, moved
there verbatim from the module that used to run it; that module keeps its
old name as an alias or a one-line shim.

Only `git` is registered. A step request may name a `backend`; farmd checks
it here before anything runs, and an absent one means `git`.
"""

from types import ModuleType

from . import git

BACKENDS: dict[str, ModuleType] = {"git": git}
DEFAULT_BACKEND = "git"


class UnknownBackend(ValueError):
    """A step request named a backend this farm does not have."""

    def __init__(self, backend: object):
        self.backend = backend
        super().__init__(f"unknown vcs backend: {backend!r}")


def get(backend: str | None = None) -> ModuleType:
    """The backend module for `backend`; `git` when it is None. Raises
    UnknownBackend for any other name or a non-string, and spawns nothing."""
    if backend is None:
        return BACKENDS[DEFAULT_BACKEND]
    if not isinstance(backend, str) or backend not in BACKENDS:
        raise UnknownBackend(backend)
    return BACKENDS[backend]
