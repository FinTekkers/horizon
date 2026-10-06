# FinTekkers — project rules

Cross-repo facts every agent on this project needs. Repo-specific build
commands live in `farm/rules/repos/`.

## Services, ports and startup order

| Service | Stack | Port |
| --- | --- | --- |
| broker-service | Rust | 80 |
| valuation-service | Rust | 8080 |
| ledger-service | Java 17 / Gradle | 8082 |
| price-service-rust | Rust | 8083 |
| Postgres | postgresql@17 via Homebrew | 5432 |

Startup order matters: **Postgres → valuation → price → ledger → broker →
ui-service**. The broker routes to everything else, so it comes up last
before the UI. Start Postgres with `brew services start postgresql@17` and
verify with `pg_isready`.

On the Horizon host (where agents run) the services are systemd units
listening on 127.0.0.1: broker 8085, valuation 8090, price 8083, ledger
8082, ui-service 3003, Postgres 16 on 5432. JDK 17 is the system Java.

## Environment quirks

- **JDK 17 for Gradle**: Gradle 7.x builds are incompatible with newer JDKs
  (JDK 25 breaks them). Prefix every Gradle command with
  `JAVA_HOME="/opt/homebrew/opt/openjdk@17"`.
- **Node 25+**: `node-sass` postinstall is broken — use
  `npm install --ignore-scripts` in Node projects that depend on it.
- If brew-installed tools aren't on PATH, run
  `eval "$(/opt/homebrew/bin/brew shellenv)"` first.
- Database credentials are never written down: the local Postgres superuser
  password comes from the `$POSTGRES_PASSWORD` environment variable, e.g.
  `DATABASE_URL=postgresql://postgres:$POSTGRES_PASSWORD@localhost:5432/postgres`.

## Architectural constraints

- All client/UI calls go through broker-service — never call a backend
  service directly.
- Cross-service calls use the gRPC interfaces defined in
  `FinTekkers/ledger-models`; protobuf models from that repo are the
  contract between services.
- ledger-service orchestrates valuation/price/security calls; individual
  services must not create circular dependencies. Stateless services
  (valuation, broker) stay stateless.

## Models first: fix shared behaviour in ledger-models

`FinTekkers/ledger-models` is the contract and the shared model library for
every service and every language (Java, Python, Rust, JS). A defect fixed
there is fixed for all of them; a workaround in one service is copied, or
drifts, in the rest. Prefer the ledger-models fix.

Fix it in ledger-models (or split the item: models part first, then the
service bumps its pinned version) when:

1. **The stack trace tops out in the models jar**: `common.models.*` or
   `protos.serializers.*`, e.g. `ProtoSerializationUtil` failing on an
   unset UUID, decimal or date. A service-side guard is at most a stopgap
   that links the models fix.
2. **The rule is about the data itself**: it holds whichever service
   receives the object (required fields, date order, a TBILL has no coupon,
   a bond needs face_value, creating nested IDs). It belongs in a models
   validator that returns field-level violations. Services keep only rules
   that need their own state: existence, duplicates, tax lots, permissions.
3. **It changes meaning**: what a field, measure or enum means, its units,
   its formula, or absent versus zero. The proto comment is the spec. Amend
   ledger-models first; an item's metric must match it, never redefine it.
4. **It needs a new request or response capability**: paging, flags, new
   RPCs. That is a proto change.
5. **The logic exists, or would have to, in two or more places**: filter
   parsing, error builders, cost-basis maths. Lift it into ledger-models.

Stays in the service: gRPC status mapping, routing (broker), persistence
and stores, indexes, calls to other services, deploy and config.

**For guardrails and plans**: don't default to "no ledger-models changes".
If a metric needs a models change, or contradicts the models contract,
say so and recommend a split; never work around it in the service. Check
the bug against the ledger-models version the service pins (its build
file), not the issue text: many reported bugs are already fixed in models.

**For reviewers**: fail a plan or change that works around a ledger-models
defect inside a service, or that redefines a model's meaning, unless it
links the ledger-models issue that removes the workaround.

## Checks versus live checks

- `scripts/checks/`: offline checks Horizon runs before merging (unit
  tests, lint). They never call a running service.
- `scripts/smoke/`: live checks against a running service, host:port from
  an argument or env var. Read-only by default; anything that writes needs
  an explicit flag, books complete valid data, and removes it after.
- The services on the Horizon host are the live FinTekkers stack. Never
  write test data to them; one bad seeded row hung ledger-service at
  startup (2026-10-06).

## Deploy topology

Unlike Horizon's direct-to-one-EC2-instance deploy, FinTekkers deploys
through a load balancer in front of multiple EC2 target groups, plus RDS —
a green health check on one instance never means the whole path is healthy.

- **Load balancer**: `fintekkers-lb` (application, internet-facing), region
  `us-east-1`, VPC `vpc-0ef340e7b25a10629`. Snapshotted before a cost-cleanup
  teardown at `infra/aws/fintekkers-lb-snapshot.json` — treat that file as
  historical reference, not a guarantee the LB is currently provisioned;
  confirm live state before assuming any of these ARNs still resolve.
- **Listeners → target groups** (from the snapshot): port `443`/`80` (HTTPS,
  web) → `fintekkers-http-web-target-group` / `fintekkers-broker-target-group`
  (broker-service); port `8080` → `fintekkers-target-group`; port `8082` →
  `fintekkers-ledger-service-targ` (gRPC health `Health/Check`); port `8083`
  → `fintekkers-price-service-targ` (gRPC health
  `grpc.health.v1.Health/Check`). Each target group has its own health check
  — a deploy that only checks the instance it changed can still be routed
  around by the LB if a *different* target group in the same request path is
  unhealthy.
- **ui-service** deploys direct via `infra/host/deploy-ui-service.sh`
  (`FinTekkers/ui-service` → `fintekkers-ui` systemd service, front end
  `https://www.fintekkers.org/`) — it does not sit behind `fintekkers-lb`.
  Its own health check already goes beyond a status code: it confirms the
  SSR shell rendered and the specific client bundle it references actually
  serves — the reference example for "deep verification" on this project.
- **RDS / Postgres**: production credentials and endpoint are environment
  variables on each service's host, never literal values here — reference
  as `$POSTGRES_PASSWORD` / `$DATABASE_URL`, same convention as the local dev
  credential below. Do not assume the local dev Postgres (Homebrew, above)
  and production RDS share an endpoint or credential.
- Credentials/DNS not captured above (AWS account, GCP project for any
  FinTekkers-side API keys, Route 53 zone) are held outside this repo — if a
  deploy needs one you can't find as an `$ENV_VAR`, treat it as a blocking
  gap, not something to guess at.
