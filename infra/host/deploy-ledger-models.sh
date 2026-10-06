#!/usr/bin/env bash
# Self-deploy for FinTekkers/ledger-models (proto models published for Java,
# Python, Rust and JS), called by Horizon's release webhook with the release
# tag. Pushes the next vX.Y.Z tag, which runs the repo's publish workflows,
# and waits for them. Maven Central only has to start: it can take hours.
# The steps live in deploy-publish-release.sh.
export DEPLOY_NAME=ledger-models
export DEPLOY_REPO_DIR=/opt/fintekkers/ledger-models
export DEPLOY_GITHUB_REPO=FinTekkers/ledger-models
export DEPLOY_REQUIRED_WORKFLOWS='cargo-publish.yml pypi-publish.yml npm-publish.yml npmjs-publish.yml maven-publish.yml'
export DEPLOY_STARTED_WORKFLOWS='maven-central.yml'
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-publish-release.sh" "$@"
