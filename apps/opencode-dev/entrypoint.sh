#!/bin/bash
# Container entrypoint: configure git identity and GitHub PAT auth.
# Writes to /tmp because the root filesystem is effectively read-only.

# Git config in /tmp (system paths are not user-writable)
export GIT_CONFIG_GLOBAL="/tmp/.gitconfig"

git config --global user.name "opencode[bot]"
git config --global user.email "noreply@github.com"

# GitHub PAT auth (GITHUB_TOKEN passed via -e flag from op inject)
if [ -n "${GITHUB_TOKEN:-}" ]; then
    git config --global credential.helper store
    echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > /tmp/.git-credentials
    chmod 600 /tmp/.git-credentials
    git config --global credential.helper "store --file=/tmp/.git-credentials"
    echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
fi

exec "$@"
