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
