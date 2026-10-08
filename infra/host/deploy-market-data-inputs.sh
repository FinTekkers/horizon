#!/usr/bin/env bash
# Self-deploy for FinTekkers/market-data-inputs (Python loaders, no service),
# called by Horizon's release webhook with the release tag. Code only: checks
# out the tag, updates the venv (scripts/checks/install.sh) and runs the
# offline tests (scripts/checks/test.sh). No loader runs, nothing restarts.
# The steps live in deploy-code-only.sh.
export DEPLOY_NAME=market-data-inputs
export DEPLOY_REPO_DIR=/opt/fintekkers/market-data-inputs
# Defence in depth: install and tests never see the ledger or price service.
export DEPLOY_STRIP_ENV='LEDGER_SERVICE_HOST LEDGER_DB_URL LEDGER_DB_USER LEDGER_DB_PASSWORD PRICE_SERVICE_HOST PRICE_SERVICE_PORT VALUATION_SERVICE_HOST'
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-code-only.sh" "$@"
