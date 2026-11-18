"""Version-control backends (HO-874): one module per backend, the same shape
as farm/providers/. Every farm `git` spawn lives in farm/vcs/git.py, moved
there verbatim from the module that used to run it; that module keeps its
old name as an alias or a one-line shim.

HO-876 registers `sl` (farm/vcs/sl.py): checkout, submit, review status and
land for a project on Sapling and Phabricator, reached through farmd's
/vcs/* routes. A step request may name a `backend`; farmd checks it here
before anything runs, and an absent one means `git`. Only the backends in
STEP_BACKENDS can run a step: an `sl` step request would provision a git hub
clone, so it is refused until sl step dispatch exists.
"""

from types import ModuleType

from . import git, sl

BACKENDS: dict[str, ModuleType] = {"git": git, "sl": sl}
DEFAULT_BACKEND = "git"
STEP_BACKENDS: tuple[str, ...] = ("git",)


class UnknownBackend(ValueError):
    """A step request named a backend this farm does not have."""

    def __init__(self, backend: object):
        self.backend = backend
        super().__init__(f"unknown vcs backend: {backend!r}")


class NoStepRuns(UnknownBackend):
    """A step request named a registered backend that cannot run steps."""

    def __init__(self, backend: str):
        super().__init__(backend)
        self.args = (f"vcs backend {backend!r} cannot run steps",)


def get(backend: str | None = None) -> ModuleType:
    """The backend module for `backend`; `git` when it is None. Raises
    UnknownBackend for any other name or a non-string, and spawns nothing."""
    if backend is None:
        return BACKENDS[DEFAULT_BACKEND]
    if not isinstance(backend, str) or backend not in BACKENDS:
        raise UnknownBackend(backend)
    return BACKENDS[backend]


def step_backend(backend: str | None = None) -> ModuleType:
    """get(), for a step request: also raises NoStepRuns for a registered
    backend outside STEP_BACKENDS. Spawns nothing."""
    module = get(backend)
    if (backend or DEFAULT_BACKEND) not in STEP_BACKENDS:
        raise NoStepRuns(backend)
    return module
