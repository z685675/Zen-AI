#!/usr/bin/env bash
set -euo pipefail

required_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

required_env NAS_SSH_HOST
required_env NAS_SSH_USER
required_env NAS_DEPLOY_PATH
required_env RELEASE_ASSETS_DIR

PORT="${NAS_SSH_PORT:-22}"
SOURCE_DIR="${RELEASE_ASSETS_DIR%/}"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Assets directory does not exist: $SOURCE_DIR" >&2
  exit 1
fi

ssh -p "$PORT" -o StrictHostKeyChecking=accept-new "${NAS_SSH_USER}@${NAS_SSH_HOST}" "mkdir -p '${NAS_DEPLOY_PATH}'"

rsync -av --delete \
  -e "ssh -p ${PORT} -o StrictHostKeyChecking=accept-new" \
  "${SOURCE_DIR}/" \
  "${NAS_SSH_USER}@${NAS_SSH_HOST}:${NAS_DEPLOY_PATH}/"

echo "Uploaded release assets to ${NAS_SSH_USER}@${NAS_SSH_HOST}:${NAS_DEPLOY_PATH}"
