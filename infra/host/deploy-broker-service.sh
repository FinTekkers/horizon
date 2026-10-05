#!/usr/bin/env bash
# Self-deploy for FinTekkers/broker-service (Rust gRPC gateway the UI talks
# to) on this host, called by Horizon's release webhook with the release tag.
# Listens on 127.0.0.1:8085. The steps live in deploy-grpc-service.sh.
export DEPLOY_NAME=broker-service
export DEPLOY_REPO_DIR=/opt/fintekkers/broker-service
export DEPLOY_SERVICE=fintekkers-broker
export DEPLOY_HEALTH_URL=http://127.0.0.1:8085/
export DEPLOY_BUILD='cargo build --release --bin broker-service-server'
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-grpc-service.sh" "$@"
