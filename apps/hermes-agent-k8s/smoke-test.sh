#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=source.env
source "$app_dir/source.env"
docker run --rm -i --read-only --tmpfs /tmp:rw \
    --entrypoint /opt/hermes/.venv/bin/python \
    -e EXPECTED_REVISION="$HERMES_FORK_REF" \
    -e HERMES_HOME=/tmp/hermes-smoke \
    -e FIRECRAWL_API_KEY= \
    -e SEARXNG_URL=http://searxng.invalid \
    "${1:?Pass the image reference to test}" - < "$app_dir/smoke-test.py"
