#!/usr/bin/env bash
# Assemble the complete fork source without modifying its Dockerfile.
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=source.env
source "$app_dir/source.env"
[[ "$HERMES_FORK_REF" =~ ^[0-9a-f]{40}$ ]] || {
    echo 'HERMES_FORK_REF must be a full commit SHA' >&2
    exit 1
}

context="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hermes-build.XXXXXX")"
git -C "$context" init --quiet
git -C "$context" remote add origin "$HERMES_FORK_REPO"
git -C "$context" fetch --quiet --depth=1 origin "$HERMES_FORK_REF"
git -C "$context" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$context" rev-parse HEAD)" = "$HERMES_FORK_REF"

python3 "$context/scripts/write_install_stamp.py" \
    --output "$context/install-stamp.json" \
    --commit "$HERMES_FORK_REF" --branch "$HERMES_FORK_BRANCH" \
    --distribution docker --update-mechanism external --source ci >&2
cp "$app_dir/Containerfile" "$context/Containerfile"
printf '%s\n' "$context"
