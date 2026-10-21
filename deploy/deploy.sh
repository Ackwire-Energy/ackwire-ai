#!/usr/bin/env bash
# Deploys a commit of this repository on a server that runs docker-compose.yml from a checkout of it:
# builds the commit's image (or pulls DEPLOY_IMAGE), migrates the database while the running app still
# serves, recreates what changed and waits for it to be healthy, or goes back to the previous image
# and commit. .github/workflows/deploy.yml runs it over SSH once CI passes on main.
#   deploy/deploy.sh [SHA]    a commit of main, in full (default: main's tip)
#
# The app restarts in place: requests fail for a few seconds while the new container boots, and up to
# about 25 s more while agent runs finish (they get 20 s, then resume in the new container).
#
# Setup: .env sets AGENTES_IMAGE=agentes:current, the tag this script moves, and with the backup
# profile AGENTES_BACKUP_IMAGE=agentes-backup:current. For the workflow, the deploy key's line in
# authorized_keys runs this script alone, with the commit the workflow sends:
#   command="/srv/agentes/deploy/deploy.sh $SSH_ORIGINAL_COMMAND",restrict ssh-ed25519 AAAA...
# With DEPLOY_IMAGE=ghcr.io/agentes-chat/agentes:edge before the script's path there, it pulls the
# image CI publishes instead of building one.
set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  if [[ -n ${1:-} && ! $1 =~ ^[0-9a-f]{40}$ ]]; then
    echo "deploy: not a full commit SHA: $1" >&2
    return 2
  fi
  [[ -n ${DEPLOY_PREVIOUS:-} ]] || git fetch --quiet origin main
  local target head
  target=$(git rev-parse --verify "${1:-origin/main}^{commit}")
  head=$(git rev-parse HEAD)
  if [[ $target != "$head" ]]; then
    # CI run again on an older commit must not take production back to it.
    if git merge-base --is-ancestor "$target" "$head"; then
      echo "deploy: ${target:0:7} is older than the checkout (${head:0:7}), nothing to do"
      return 0
    fi
    git checkout --quiet --detach "$target"
    # The commit's own version of this script does the rest.
    DEPLOY_PREVIOUS=$head exec bash deploy/deploy.sh "$target"
  fi
  local previous=${DEPLOY_PREVIOUS:-$head}
  # Until the new version is healthy, a failure puts the checkout back on the commit that runs.
  trap 'git checkout --quiet --detach "$previous"' ERR

  if ! docker compose config --images | grep -x 'agentes:current' >/dev/null; then
    echo "deploy: set AGENTES_IMAGE=agentes:current in .env, the tag this script moves" >&2
    false
  fi
  echo "deploy: ${target:0:7}"
  if [[ -n ${DEPLOY_IMAGE:-} ]]; then
    docker pull --quiet "$DEPLOY_IMAGE"
    docker tag "$DEPLOY_IMAGE" agentes:next
  else
    docker build --tag agentes:next .
  fi
  if docker compose config --services | grep -x backup >/dev/null; then
    docker build --quiet --tag agentes-backup:current deploy/backup
  fi

  local current swapped=
  current=$(docker image inspect --format '{{.Id}}' agentes:current 2>/dev/null || true)
  if [[ $(docker image inspect --format '{{.Id}}' agentes:next) != "$current" ]]; then
    # Before the swap: a migration that fails leaves the running app serving.
    AGENTES_IMAGE=agentes:next docker compose run --rm agentes migrate
    if [[ -n $current ]]; then
      docker tag agentes:current agentes:previous
      swapped=1
    fi
    docker tag agentes:next agentes:current
  fi
  if ! docker compose up --detach --wait --wait-timeout 180; then
    docker compose logs --no-color --tail 50 agentes >&2 || true
    echo "deploy: ${target:0:7} is not healthy, going back to ${previous:0:7}" >&2
    git checkout --quiet --detach "$previous"
    if [[ -n $swapped ]]; then
      docker tag agentes:previous agentes:current
      # The new version may have migrated the database already, which the previous one refuses at boot.
      export RUN_MIGRATIONS_ON_BOOT=false
      echo "deploy: until a fix is live, run docker compose with RUN_MIGRATIONS_ON_BOOT=false" >&2
    fi
    docker compose up --detach --wait --wait-timeout 180 || echo "deploy: the rollback is not healthy either" >&2
    return 1
  fi
  trap - ERR
  docker image prune --force >/dev/null
  docker builder prune --force --filter until=24h >/dev/null
  echo "deploy: ${target:0:7} is live"
}

# The checkout changes under this file while it runs: bash has read all of it once this line starts.
main "$@"; exit
