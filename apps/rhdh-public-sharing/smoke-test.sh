#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-test.sh IMAGE}
package_type=${2:-frontend}
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
  echo 'Expected one OCI layer containing the exported plugin package.' >&2
  exit 1
fi
layer=$(jq -r '.layers[0].digest | split(":")[1]' "$manifest")
archive="$artifact_tmpdir/image/$layer"
case "$package_type" in
  frontend)
    tar -tf "$archive" package.json dist/remoteEntry.js > /dev/null
    tar -xOf "$archive" package.json | jq -e \
      '.backstage.features["./alpha"] == "@backstage/FrontendPlugin" and .exports["./alpha"] != null' > /dev/null
    tar -xOf "$archive" dist/remoteEntry.js | grep -F './alpha' > /dev/null
    ;;
  backend)
    tar -tf "$archive" package.json node_modules/express/package.json node_modules/yaml/package.json > /dev/null
    entrypoint=$(tar -xOf "$archive" package.json | jq -er '.main')
    tar -tf "$archive" "${entrypoint#./}" > /dev/null
    ;;
  *) echo "Unknown plugin type: $package_type" >&2; exit 1 ;;
esac
echo "Verified standalone RHDH 2.1 $package_type artifact."
