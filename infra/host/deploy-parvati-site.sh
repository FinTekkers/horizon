#!/usr/bin/env bash
# Deploy target for ParvatiRealEstate/parvati-site, the Shoreward video's
# tenant site: GitHub Pages publishes it; deploy-github-pages.sh waits for that.
export DEPLOY_NAME=parvati-site
export DEPLOY_PAGES_REPO=ParvatiRealEstate/parvati-site
export DEPLOY_PAGES_URL=https://parvatirealestate.github.io/parvati-site/
exec "$(dirname "${BASH_SOURCE[0]}")/deploy-github-pages.sh" "$@"
