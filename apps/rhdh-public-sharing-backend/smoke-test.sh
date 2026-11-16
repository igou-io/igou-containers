#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/../rhdh-public-sharing/smoke-test.sh" "$1" backend
