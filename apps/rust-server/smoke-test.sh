#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"${CONTAINER_ENGINE:-docker}" run --rm -i --read-only --network none \
    --user 12345:0 --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw --tmpfs /data:rw,mode=0770 \
    --entrypoint /opt/venv/bin/python \
    "${1:?Pass the image reference to test}" - < "$app_dir/smoke-test.py"
