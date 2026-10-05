#!/usr/bin/env bash
# Self-deploy for FinTekkers/ledger-service (Java gRPC server) on this host,
# called by Horizon's release webhook with the release tag. Listens on :8082.
# installDist writes subledger/build/install/subledger/, which the unit runs.
# Startup loads the ledger from Postgres, so it gets longer to report SERVING.
# The steps live in deploy-grpc-service.sh.
export DEPLOY_NAME=ledger-service
export DEPLOY_REPO_DIR=/opt/fintekkers/ledger-service
export DEPLOY_SERVICE=fintekkers-ledger
export DEPLOY_HEALTH_URL=http://127.0.0.1:8082/
export DEPLOY_HEALTH_TIMEOUT_S=180
export DEPLOY_BUILD='JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}" ./gradlew :subledger:installDist --no-daemon --console=plain'
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-grpc-service.sh" "$@"
