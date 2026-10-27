#!/usr/bin/env bash
set -euo pipefail

# Only immutable patch subdirectories; never rsync --delete or overwrite installer/update metadata.
: "${HOTPATCH_SSH_HOST:?}" "${HOTPATCH_SSH_USER:?}" "${HOTPATCH_DEPLOY_ROOT:?}"
: "${HOTPATCH_SOURCE_DIR:?}" "${HOTPATCH_BASE_ID:?}" "${HOTPATCH_PATCH_ID:?}"
: "${HOTPATCH_SSH_KEY_FILE:?}" "${HOTPATCH_KNOWN_HOSTS_FILE:?}"
[[ "$HOTPATCH_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ && "$HOTPATCH_SSH_USER" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]*$ ]]
[[ "$HOTPATCH_BASE_ID" =~ ^[a-f0-9]{64}$ && "$HOTPATCH_PATCH_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]
[[ "$HOTPATCH_DEPLOY_ROOT" =~ ^/([A-Za-z0-9_-]+/)+zen-ai/hotpatch$ ]]
[[ "${HOTPATCH_SSH_PORT:-22}" =~ ^[0-9]{1,5}$ ]]
[[ -d "$HOTPATCH_SOURCE_DIR" && -f "$HOTPATCH_SOURCE_DIR/snapshot.zip" && -f "$HOTPATCH_SOURCE_DIR/manifest.json" ]]
[[ -s "$HOTPATCH_SSH_KEY_FILE" && -s "$HOTPATCH_KNOWN_HOSTS_FILE" ]]
port="${HOTPATCH_SSH_PORT:-22}"
parent="$HOTPATCH_DEPLOY_ROOT/$HOTPATCH_BASE_ID"
destination="$parent/$HOTPATCH_PATCH_ID"
staging="$parent/.upload-$(openssl rand -hex 16)"
remote="$HOTPATCH_SSH_USER@$HOTPATCH_SSH_HOST"
options=(-F /dev/null -i "$HOTPATCH_SSH_KEY_FILE" -o "UserKnownHostsFile=$HOTPATCH_KNOWN_HOSTS_FILE" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes)
ssh -p "$port" "${options[@]}" "$remote" \
  "set -eu; test -d '$HOTPATCH_DEPLOY_ROOT'; test ! -L '$HOTPATCH_DEPLOY_ROOT'; test \"\$(readlink -f '$HOTPATCH_DEPLOY_ROOT')\" = '$HOTPATCH_DEPLOY_ROOT'; mkdir -p '$parent'; test ! -L '$parent'; test \"\$(readlink -f '$parent')\" = '$parent'; test ! -e '$destination'; test ! -L '$destination'; mkdir -m 755 '$staging'"
# On transfer failure the random staging directory is left unserved; no risky remote recursive cleanup.
scp -P "$port" "${options[@]}" \
  "$HOTPATCH_SOURCE_DIR/manifest.json" "$HOTPATCH_SOURCE_DIR/snapshot.zip" "$remote:$staging/"
ssh -p "$port" "${options[@]}" "$remote" \
  "set -eu; test -d '$staging'; test ! -L '$staging'; chmod 644 '$staging/manifest.json' '$staging/snapshot.zip'; test ! -e '$destination'; test ! -L '$destination'; mv -T -n '$staging' '$destination'; test ! -e '$staging'"
printf 'Uploaded immutable patch %s/%s; HTTPS verification is still required.\n' "$HOTPATCH_BASE_ID" "$HOTPATCH_PATCH_ID"
