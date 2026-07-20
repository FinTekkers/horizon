# FinTekkers/ledger-models — repo rules

The shared protobuf model library every FinTekkers service depends on.

## Tech stack

- Protocol Buffers — golden source definitions in `ledger-models-protos/`
- Language implementations: Java, Python, Rust, JavaScript/TypeScript,
  all generated from the proto files.

## Build & test

- **Compile protos:** `./compile.sh` at the repo root — regenerates code for
  all languages. Requires `protoc` (`brew install protobuf`, verify with
  `protoc --version`).
- **Java:** `cd ledger-models-java && JAVA_HOME="/opt/homebrew/opt/openjdk@17" ./gradlew test`
  (Gradle needs JDK 17 — newer JDKs are incompatible).
- **Python:** `cd ledger-models-python && python -m pytest` (use a venv).
- **Rust:** `cd ledger-models-rust && cargo test`
- **JavaScript:** `cd ledger-models-javascript && npm test`

## Project structure

- `ledger-models-protos/` — golden source:
  `fintekkers/models/` (position, security, portfolio, price, …),
  `fintekkers/requests/` (request/response messages),
  `fintekkers/services/` (gRPC service definitions).
- `ledger-models-java|python|rust|javascript/` — per-language
  implementations; the JS one publishes as `@fintekkers/ledger-models` on npm.

## Workflow after proto changes

1. Edit proto files in `ledger-models-protos/`.
2. Run `./compile.sh` to regenerate all language bindings.
3. Fix any compilation errors in language-specific code.
4. Run the tests in ALL languages — every implementation must stay in sync.
5. Only then mark the task complete.

## Constraints

- Never make breaking proto changes without explicit PM approval; downstream
  services consume published releases.
- Every new model/field needs an ADR (Architecture Decision Record) in this
  repo explaining the design rationale.
- Ensure backward compatibility or coordinate breaking changes.
