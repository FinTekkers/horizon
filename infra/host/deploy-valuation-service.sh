#!/usr/bin/env bash
# Self-deploy for FinTekkers/valuation-service (Rust gRPC server) on this host,
# called by Horizon's release webhook with the release tag. Listens on
# 127.0.0.1:8080, its default port (PORT/IPV4 in the unit; the WhatsApp
# bridge moved to 8090 on 2026-10-07). The steps live in deploy-grpc-service.sh.
export DEPLOY_NAME=valuation-service
export DEPLOY_REPO_DIR=/opt/fintekkers/valuation-service
export DEPLOY_SERVICE=fintekkers-valuation
export DEPLOY_HEALTH_URL=http://127.0.0.1:8080/
export DEPLOY_BUILD='cargo build --release --bin valuation-service-server'
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-grpc-service.sh" "$@"
