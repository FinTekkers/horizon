#!/usr/bin/env bash
# Self-deploy for FinTekkers/valuation-service (Rust gRPC server) on this host,
# called by Horizon's release webhook with the release tag. Listens on
# 127.0.0.1:8090 (PORT/IPV4 in the unit; 8080 is the WhatsApp bridge on this
# host). The steps live in deploy-grpc-service.sh.
export DEPLOY_NAME=valuation-service
export DEPLOY_REPO_DIR=/opt/fintekkers/valuation-service
export DEPLOY_SERVICE=fintekkers-valuation
export DEPLOY_HEALTH_URL=http://127.0.0.1:8090/
export DEPLOY_BUILD='cargo build --release --bin valuation-service-server'
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-grpc-service.sh" "$@"
