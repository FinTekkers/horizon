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
