"""HO-840: the rehearsal's GET/HEAD egress proxy, as farm/rehearsal.py hooks.

A plan whose `rehearsal.services` names hosts gets EgressHooks (hooks_for);
any other plan gets none, so no proxy starts and the sandbox keeps
`--network=none`. rehearsal.run() owns the order, the 210 s cap and
teardown; this module only fills in the hooks:

- `start` (inside the cap): a one-day CA made with `openssl` whose
  nameConstraints allow only the declared names, one leaf per host; an
  `--internal --disable-dns` network for the sandbox and a second one for the
  proxy's way out; the proxy sidecar (container_runner.egress_proxy_argv, the
  pinned image, never pulled here) on both; its IP on the internal network;
  then `podman logs` polled for egress_proxy.READY. Every call is bounded by
  the deadline. Out of time, it waits out the deadline and returns no flags,
  which rehearsal.run() reports as `rehearsal_timeout`. Anything that cannot
  be had raises container_runner.Unavailable — never a weaker network.
- its flags: `--network=<internal>` (the sandbox's only network: no route, no
  DNS, so the proxy is its one way out), the CA certificate read-only, and
  the proxy and CA names, whose values ride in the podman client's env.
- `check`: reads the proxy's log while it is still up. Any refusal line, or a
  log that cannot be read, fails the rehearsal as `rehearsal_write_refused`.
  Each refusal is kept on `refused` and logged as its REFUSAL_RE line —
  method and host only.
- `stop`: reads the log first if `check` never did, then removes the proxy,
  both networks and the cert dir. Each step is bounded and never raises; it
  runs outside the cap, by design (rehearsal.run() leaves teardown untimed),
  so do not wrap it in the cap's budget.

The CA's key stays in a mode-0700 dir of the farm's and is never mounted. A
leaf key is mounted read-only into the proxy only. reap_orphans() removes
what a killed farmd left: a rehearsal runs inside farmd, so at boot none of
this farm's egress containers or networks is live.
"""

import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

from domain.py import run_plan

from . import container_runner, egress_proxy, rehearsal

SCRIPT = Path(__file__).resolve().with_name("egress_proxy.py")
POLL_S = 0.1
TEARDOWN_S = 30
# The sidecar outlives a killed farmd by at most the cap plus this.
SIDECAR_MARGIN_S = 60
CA_SUBJECT = "/CN=horizon-rehearsal-egress"


class CapExceeded(Exception):
    """Start-up ran past the rehearsal's deadline."""


# One "<network> <ip>" line per network the proxy joined. A Go template, so
# nothing here parses JSON from a command's output.
NETWORKS_FORMAT = "{{range $name, $net := .NetworkSettings.Networks}}{{println $name $net.IPAddress}}{{end}}"


def proxy_image() -> str:
    """FARM_EGRESS_PROXY_IMAGE, else the image a `host` plan rehearses in —
    already pulled for the rehearsal, and it has python3."""
    return os.environ.get("FARM_EGRESS_PROXY_IMAGE") or rehearsal.image_for("host", None)


def hooks_for(block: dict, *, item_id: str) -> "EgressHooks | None":
    """EgressHooks for a plan with `rehearsal.services`, else None."""
    section = block.get("rehearsal") if isinstance(block.get("rehearsal"), dict) else {}
    services = section.get("services") or []
    return EgressHooks(services, item_id=item_id) if services else None


def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise CapExceeded
    return left


def _run(argv: list, deadline: float | None, *, limit: float = TEARDOWN_S) -> subprocess.CompletedProcess:
    """One bounded host command, its output in memory. Raises CapExceeded
    when the deadline has passed or the command outlives it (TimeoutExpired
    with no deadline). It runs in a session of its own, and a timeout kills
    the whole group: a client that forked (a launcher, podman's own helpers)
    must not finish starting something after teardown has run."""
    timeout = min(limit, _remaining(deadline)) if deadline is not None else limit
    with subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace", cwd="/", start_new_session=True
    ) as process:
        try:
            out, err = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            process.communicate()
            if deadline is not None:
                raise CapExceeded from None
            raise
    return subprocess.CompletedProcess(argv, process.returncode, out, err)


class EgressHooks(rehearsal.RehearsalHooks):
    """One rehearsal's egress proxy. `refused` holds (method, host) for each
    refusal the proxy logged; `unread` is True when its log could not be
    read (which fails the rehearsal too)."""

    def __init__(self, services: list, *, item_id: str, image: str | None = None):
        self.services = [dict(s) for s in services if isinstance(s, dict)]
        self.image = image or proxy_image()
        safe = re.sub(r"[^a-z0-9-]", "-", str(item_id or "item").lower())[:30]
        stem = f"{container_runner.EGRESS_PREFIX}{safe}-{secrets.token_hex(4)}"
        self.proxy_name = stem
        self.internal = f"{stem}-in"
        self.egress = f"{stem}-out"
        self.work_dir: str | None = None
        self.refused: list[tuple[str, str]] = []
        self.unread = False
        self._values: dict = {}
        self._made: list[str] = []
        self._proxy_started = False
        self._ready = False
        self._collected = False
        self._stopped = False

    # ---- RehearsalHooks ----

    def start(self, deadline: float) -> list[str] | None:
        if not self.services:
            return None
        try:
            return self._start(deadline)
        except OSError:
            # A cert dir or file that cannot be made: fail closed, never a
            # weaker network — and never the error's text, which names paths.
            raise container_runner.Unavailable("the egress proxy could not be set up on this host") from None
        except CapExceeded:
            # rehearsal.run() reports a return past the deadline as
            # rehearsal_timeout, and never starts the sandbox.
            while time.monotonic() < deadline:
                time.sleep(min(POLL_S, max(0.0, deadline - time.monotonic())))
            return None

    def env(self) -> dict[str, str] | None:
        return dict(self._values) or None

    def check(self, name: str, deadline: float) -> str | None:
        self._collect()
        return rehearsal.WRITE_REFUSED if self.unread or self.refused else None

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self._ready and not self._collected:
            self._collect()
        if self._proxy_started:
            container_runner.stop_and_remove(self.proxy_name)
        for network in reversed(self._made):
            try:
                _run([container_runner.podman_bin(), "network", "rm", "-f", network], None)
            except (OSError, subprocess.SubprocessError):
                pass
        if self.work_dir:
            shutil.rmtree(self.work_dir, ignore_errors=True)

    # ---- start-up ----

    def _checked_hosts(self) -> list[tuple[str, str]]:
        """(host, reads) of each service — re-checked with the plan
        contract's own rule, so no other name ever reaches the proxy."""
        hosts: list[tuple[str, str]] = []
        if len(self.services) > run_plan.CONTRACT["maxServices"]:
            raise container_runner.Unavailable("the rehearsal declares too many services for the egress proxy")
        for service in self.services:
            host = service.get("host")
            if not isinstance(host, str) or not run_plan.SERVICE_HOST.fullmatch(host) or host in {h for h, _ in hosts}:
                raise container_runner.Unavailable("a rehearsal service host is not an exact DNS name the egress proxy can serve")
            hosts.append((host, "refuse" if service.get("reads") == "refuse" else "allow"))
        return hosts

    def _start(self, deadline: float) -> list[str]:
        hosts = self._checked_hosts()
        self.work_dir = tempfile.mkdtemp(prefix=container_runner.EGRESS_PREFIX)
        ca_dir = os.path.join(self.work_dir, "ca")
        conf_dir = os.path.join(self.work_dir, "conf")
        public_dir = os.path.join(self.work_dir, "public")
        for directory in (ca_dir, conf_dir, public_dir):
            os.mkdir(directory, 0o700)
        certs = self._make_certs(hosts, ca_dir, conf_dir, public_dir, deadline)
        config = {
            "listen": ["0.0.0.0", egress_proxy.LISTEN_PORT],
            "services": [{"host": host, "reads": reads} for host, reads in hosts],
            "certs": certs,
        }
        Path(conf_dir, "config.json").write_text(json.dumps(config))

        self._network(["--internal", "--disable-dns"], self.internal, deadline, "the egress proxy's internal network could not be created")
        self._network([], self.egress, deadline, "the egress proxy's outbound network could not be created")
        argv = container_runner.egress_proxy_argv(
            image=self.image,
            name=self.proxy_name,
            internal=self.internal,
            egress=self.egress,
            script=str(SCRIPT),
            conf_dir=conf_dir,
            timeout_s=int(_remaining(deadline)) + SIDECAR_MARGIN_S,
        )
        self._proxy_started = True
        try:
            started = _run(argv, deadline, limit=120)
        except OSError:
            raise container_runner.Unavailable("podman could not run the egress proxy") from None
        if started.returncode != 0:
            raise container_runner.Unavailable("the egress proxy did not start (is its image pulled? it is never pulled during a rehearsal)")
        address = self._address(deadline)
        self._wait_ready(deadline)
        self._ready = True

        proxy = f"http://{address}:{egress_proxy.LISTEN_PORT}"
        ca_file = os.path.join(public_dir, "ca.pem")
        values = {name: proxy for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")}
        values.update({"NO_PROXY": "", "no_proxy": ""})
        values.update({name: container_runner.REHEARSAL_CA_MOUNT for name in container_runner.REHEARSAL_CA_ENV})
        self._values = values
        return [
            f"--network={self.internal}",
            f"--volume={ca_file}:{container_runner.REHEARSAL_CA_MOUNT}:ro",
            *[f"--env={name}" for name in values],
        ]

    def _openssl(self, args: list, deadline: float) -> None:
        try:
            made = _run(["openssl", *args], deadline)
        except OSError:
            raise container_runner.Unavailable("openssl is not installed for the farm user") from None
        if made.returncode != 0:
            raise container_runner.Unavailable("the egress proxy's certificates could not be made")

    def _make_certs(self, hosts: list, ca_dir: str, conf_dir: str, public_dir: str, deadline: float) -> dict:
        """The CA (key kept in `ca_dir`, certificate copied to `public_dir`)
        and one leaf per host in `conf_dir`: {host: [cert, key]} as the
        proxy sees them."""
        ca_key, ca_cert = os.path.join(ca_dir, "ca.key"), os.path.join(ca_dir, "ca.pem")
        permitted = ",".join(f"permitted;DNS:{host}" for host, _ in hosts)
        ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1"]
        self._openssl(
            ["req", "-x509", "-new", *ec, "-keyout", ca_key, "-out", ca_cert, "-subj", CA_SUBJECT,
             "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
             "-addext", "keyUsage=critical,keyCertSign,cRLSign",
             "-addext", f"nameConstraints=critical,{permitted}"],
            deadline,
        )
        certs = {}
        for index, (host, _) in enumerate(hosts, 1):
            leaf_key, leaf_cert = os.path.join(conf_dir, f"leaf-{index}.key"), os.path.join(conf_dir, f"leaf-{index}.pem")
            self._openssl(
                ["req", "-x509", "-new", *ec, "-keyout", leaf_key, "-out", leaf_cert, "-subj", f"/CN={host}",
                 "-CA", ca_cert, "-CAkey", ca_key,
                 "-addext", f"subjectAltName=DNS:{host}",
                 "-addext", "basicConstraints=critical,CA:FALSE",
                 "-addext", "keyUsage=critical,digitalSignature",
                 "-addext", "extendedKeyUsage=serverAuth"],
                deadline,
            )
            mount = container_runner.EGRESS_CONF_MOUNT
            certs[host] = [f"{mount}/leaf-{index}.pem", f"{mount}/leaf-{index}.key"]
        shutil.copyfile(ca_cert, os.path.join(public_dir, "ca.pem"))
        return certs

    def _network(self, flags: list, name: str, deadline: float, refusal: str) -> None:
        argv = [container_runner.podman_bin(), "network", "create", *flags,
                "--label", container_runner.owner_label(), "--label", container_runner.EGRESS_LABEL, name]
        try:
            made = _run(argv, deadline)
        except OSError:
            raise container_runner.Unavailable(refusal) from None
        if made.returncode != 0:
            raise container_runner.Unavailable(refusal)
        self._made.append(name)

    def _address(self, deadline: float) -> str:
        """The proxy's IP on the internal network, from `podman inspect`."""
        try:
            seen = _run([container_runner.podman_bin(), "inspect", "--format", NETWORKS_FORMAT, self.proxy_name], deadline)
            networks = dict(line.split(" ", 1) for line in seen.stdout.splitlines() if line.strip())
            address = networks[self.internal].strip()
            ipaddress.ip_address(address)
            return address
        except CapExceeded:
            raise
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError, TypeError):
            raise container_runner.Unavailable("the egress proxy's address could not be read") from None

    def _logs(self, deadline: float | None) -> str | None:
        """The proxy's log (stdout and stderr), or None when it cannot be read."""
        try:
            res = _run([container_runner.podman_bin(), "logs", self.proxy_name], deadline)
        except (OSError, subprocess.SubprocessError):
            return None
        return res.stdout + "\n" + res.stderr if res.returncode == 0 else None

    def _wait_ready(self, deadline: float) -> None:
        while True:
            log = self._logs(deadline)
            if log is None:
                raise container_runner.Unavailable("the egress proxy exited before it was ready")
            if egress_proxy.READY in log.splitlines():
                return
            time.sleep(min(POLL_S, _remaining(deadline)))

    # ---- refusals ----

    def _collect(self) -> None:
        """Reads the proxy's refusal lines once, while it is still up. Only a
        line matching REFUSAL_RE whole is kept or logged."""
        if self._collected or not self._ready:
            return
        self._collected = True
        log = self._logs(None)
        if log is None:
            self.unread = True
            print("farmd: rehearsal egress proxy log could not be read (rehearsal_write_refused)", flush=True)
            return
        for line in log.splitlines():
            line = line.strip()
            if not egress_proxy.REFUSAL_RE.match(line):
                continue
            _, method_part, host_part = line.split(" ")
            self.refused.append((method_part.split("=", 1)[1], host_part.split("=", 1)[1]))
            print(f"farmd: rehearsal egress {line}", flush=True)


def reap_orphans() -> list[str]:
    """Removes every egress container and network of this farm's (its owner
    label and EGRESS_LABEL) — what a killed farmd left behind. Returns the
    names removed. Never raises."""
    owner, egress = f"label={container_runner.owner_label()}", f"label={container_runner.EGRESS_LABEL}"
    removed: list[str] = []
    try:
        listed = _run([container_runner.podman_bin(), "ps", "-a", "--filter", owner, "--filter", egress, "--format", "{{.Names}}"], None)
        for name in listed.stdout.split() if listed.returncode == 0 else []:
            if name.startswith(container_runner.EGRESS_PREFIX):
                container_runner.stop_and_remove(name)
                removed.append(name)
        listed = _run([container_runner.podman_bin(), "network", "ls", "--filter", owner, "--filter", egress, "--format", "{{.Name}}"], None)
        for name in listed.stdout.split() if listed.returncode == 0 else []:
            if name.startswith(container_runner.EGRESS_PREFIX):
                _run([container_runner.podman_bin(), "network", "rm", "-f", name], None)
                removed.append(name)
    except (OSError, subprocess.SubprocessError):
        pass
    return removed


def host_gaps() -> list[str]:
    """What this host lacks for an egress proxy: `openssl` on PATH, and
    netavark as podman's network backend (`--internal` networks need it).
    farmd logs these at boot; a rehearsal with services fails closed."""
    gaps = []
    if shutil.which("openssl") is None:
        gaps.append("openssl is not on PATH")
    try:
        backend = _run([container_runner.podman_bin(), "info", "--format", "{{.Host.NetworkBackend}}"], None)
        if backend.returncode != 0 or backend.stdout.strip() != "netavark":
            gaps.append("podman's network backend is not netavark")
    except (OSError, subprocess.SubprocessError):
        gaps.append("podman's network backend could not be read")
    return gaps
