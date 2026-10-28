#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-test.sh IMAGE}
case "$image" in
  docker://*|containers-storage:*) ;;
  *) image="docker://$image" ;;
esac

artifact_tmpdir=$(mktemp -d)
trap 'rm -r -- "$artifact_tmpdir"' EXIT
skopeo copy --override-os linux --override-arch amd64 \
  "$image" "dir:$artifact_tmpdir/image" > /dev/null

manifest="$artifact_tmpdir/image/manifest.json"
if ! jq -e '.layers | length == 1' "$manifest" > /dev/null; then
  echo 'RHDH 1.10 requires both plugin packages in the first OCI layer.' >&2
  exit 1
fi
layer=$(jq -r '.layers[0].digest | split(":")[1]' "$manifest")
archive="$artifact_tmpdir/image/$layer"
frontend=igou-plugin-public-sharing
backend=igou-plugin-public-sharing-backend

tar -tf "$archive" \
  "$frontend/package.json" \
  "$frontend/dist-scalprum/plugin-manifest.json" \
  "$backend/package.json" \
  "$backend/node_modules/express/package.json" \
  "$backend/node_modules/yaml/package.json" > /dev/null

entrypoint=$(tar -xOf "$archive" "$backend/package.json" | jq -er '.main')
tar -tf "$archive" "$backend/${entrypoint#./}" > /dev/null
echo 'Verified both RHDH packages and backend dependencies in the first OCI layer.'
