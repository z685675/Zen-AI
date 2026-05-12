#!/usr/bin/env bash
set -euo pipefail

required_env() {
  local name="$1"
  local value="${!name:-}"
  value="${value//$'\r'/}"
  value="$(printf '%s' "$value")"
  if [[ -z "$value" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
  printf '%s' "$value"
}

ALI_SSH_HOST="$(required_env ALI_SSH_HOST)"
ALI_SSH_USER="$(required_env ALI_SSH_USER)"
ALI_DEPLOY_PATH="$(required_env ALI_DEPLOY_PATH)"
RELEASE_ASSETS_DIR="$(required_env RELEASE_ASSETS_DIR)"

PORT="$(printf '%s' "${ALI_SSH_PORT:-22}" | tr -d '\r\n')"
SOURCE_DIR="${RELEASE_ASSETS_DIR%/}"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Assets directory does not exist: $SOURCE_DIR" >&2
  exit 1
fi

ssh -p "$PORT" -o StrictHostKeyChecking=accept-new "${ALI_SSH_USER}@${ALI_SSH_HOST}" "mkdir -p '${ALI_DEPLOY_PATH}'"

rsync -av --delete \
  -e "ssh -p ${PORT} -o StrictHostKeyChecking=accept-new" \
  "${SOURCE_DIR}/" \
  "${ALI_SSH_USER}@${ALI_SSH_HOST}:${ALI_DEPLOY_PATH}/"

echo "Uploaded release assets to ${ALI_SSH_USER}@${ALI_SSH_HOST}:${ALI_DEPLOY_PATH}"
