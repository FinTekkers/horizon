#!/usr/bin/env bash
# Self-deploy for FinTekkers/price-service-rust (Rust gRPC server) on this
# host, called by Horizon's release webhook with the release tag. Listens on
# 127.0.0.1:8083. The repo's default branch is master, not main. The steps
# live in deploy-grpc-service.sh.
export DEPLOY_NAME=price-service
export DEPLOY_REPO_DIR=/opt/fintekkers/price-service-rust
export DEPLOY_SERVICE=fintekkers-price
export DEPLOY_HEALTH_URL=http://127.0.0.1:8083/
export DEPLOY_DEFAULT_REF=origin/master
export DEPLOY_BUILD='cargo build --release --bin price-service-rust'
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-grpc-service.sh" "$@"
