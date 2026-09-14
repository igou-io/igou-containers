#!/usr/bin/env bash
set -euo pipefail

DOCKERFILE="${DOCKERFILE:-apps/codex/Containerfile}"
CHECK_ONLY=false

if [[ "${1:-}" == "--check" ]]; then
    CHECK_ONLY=true
elif [[ $# -gt 0 ]]; then
    printf 'usage: %s [--check]\n' "$0" >&2
    exit 2
fi

get_arg() {
    local name="$1"
    sed -n -E "s/^ARG ${name}=\"([^\"]+)\"$/\1/p" "$DOCKERFILE" | head -1
}

set_sha_arg() {
    local name="$1"
    local sha="$2"
    local current

    if [[ ! "$sha" =~ ^[0-9a-f]{64}$ ]]; then
        printf 'error: refusing to set %s: %s is not a SHA256\n' "$name" "$sha" >&2
        exit 1
    fi

    current="$(get_arg "$name")"
    if [[ "$current" == "$sha" ]]; then
        return
    fi

    if [[ "$CHECK_ONLY" == true ]]; then
        printf 'error: %s is stale (expected %s, found %s)\n' "$name" "$sha" "$current" >&2
        return 1
    fi

    sed -i -E "s|^ARG ${name}=\"[^\"]+\"$|ARG ${name}=\"${sha}\"|" "$DOCKERFILE"
}

CODEX_VERSION="$(get_arg CODEX_VERSION)"
if [[ ! "$CODEX_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'error: could not read a semver CODEX_VERSION from %s\n' "$DOCKERFILE" >&2
    exit 1
fi

SUMS_URL="https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package_SHA256SUMS"
SUMS="$(curl -fsSL --retry 3 "$SUMS_URL")"

for pair in \
    "x86_64:CODEX_SHA256_X64" \
    "aarch64:CODEX_SHA256_ARM64"; do
    triple="${pair%%:*}-unknown-linux-musl"
    variable="${pair#*:}"
    asset="codex-package-${triple}.tar.gz"
    sha="$(printf '%s\n' "$SUMS" | awk -v asset="$asset" '$2 == asset { print $1; exit }')"

    if [[ -z "$sha" ]]; then
        printf 'error: no checksum found for %s in %s\n' "$asset" "$SUMS_URL" >&2
        exit 1
    fi

    set_sha_arg "$variable" "$sha"
done

if [[ "$CHECK_ONLY" == true ]]; then
    printf 'Codex %s checksums are current.\n' "$CODEX_VERSION"
else
    printf 'Updated Codex %s checksums in %s.\n' "$CODEX_VERSION" "$DOCKERFILE"
fi
