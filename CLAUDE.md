# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

Monorepo for building container images, pushed to GHCR (`ghcr.io/igou-io/<app>`). Each app lives under `apps/<app-name>/` with its own `Containerfile` and build context.

## CI/CD

GitHub Actions workflow (`.github/workflows/build-containers.yml`) automatically detects which `apps/` subdirectories changed and builds only those. Images are built for `linux/amd64` and `linux/arm64`, pushed on merge to `main`. PRs get build-only (no push).

Image tags: `latest`, `YYYY.MM.DD`, full commit SHA, and branch name.

## Adding a New App

1. Create `apps/<app-name>/` with a `Containerfile` and any build context files.
2. The CI workflow will automatically pick it up on the next push that touches that directory.

## Current Apps

### mcpo

An [MCPO](https://github.com/open-webui/mcpo) (MCP-to-OpenAPI proxy) container bundling several MCP servers. Built on UBI 10 micro with a multi-stage distroless-style build pattern:
- Stage 1: UBI micro base filesystem
- Stage 2: UBI full image installs packages into a custom installroot, then uses `uv` to sync Python dependencies from `uv.lock`
- Final stage: `FROM scratch`, copies only the installroot and `/app` — no package manager or shell in the final image

Python dependencies managed via `uv` with `pyproject.toml` + `uv.lock`. Renovate bot keeps dependencies updated.

### claude-code

Hardened UBI10-based container for running Claude Code as an agent with infrastructure tools baked in. Self-contained three-stage build (no separate base image):
- Stage 1: UBI micro base filesystem
- Stage 2: UBI full image installs system packages, CLI tools (kubectl, helm, argocd, etc.), and Python packages (ansible, yq, etc.) into a custom installroot
- Claude build stage: installs Claude Code CLI and seccomp filter (bubblewrap + `@anthropic-ai/sandbox-runtime`)
- Final stage: `FROM scratch`, copies rootfs + Claude binaries — no package manager in the final image

Hardened at runtime via podman flags (`--cap-drop=ALL`, noexec `/tmp`, resource limits) and Claude Code sandbox settings baked at `/etc/claude/settings.json`. Entrypoint merges baked MCP and sandbox config into user config at startup.

**Dependencies managed by Renovate:**
- `requirements.txt` — Python packages (pip_requirements manager)
- `package.json` — `@anthropic-ai/sandbox-runtime` seccomp filter (npm manager)
- `# renovate:` ARG annotations — CLI tool binary versions (custom regex manager)
- `FROM` lines — UBI base image digests (dockerfile manager)

### cursor-agent-cli

Hardened UBI10-based container for running Cursor's agent CLI with the same infrastructure tools as claude-code. Same three-stage build pattern:
- Stage 1: UBI micro base filesystem
- Stage 2: UBI full image installs system packages, CLI tools, and Python packages into a custom installroot
- Cursor build stage: installs Cursor agent CLI
- Final stage: `FROM scratch`, copies rootfs + Cursor binaries

Sandbox config baked at `/etc/cursor/sandbox.json` with network deny-by-default policy. Entrypoint merges baked sandbox config into workspace `.cursor/sandbox.json` at startup.

**Dependencies managed by Renovate:**
- `requirements.txt` — Python packages (pip_requirements manager)
- `# renovate:` ARG annotations — CLI tool binary versions (custom regex manager)
- `FROM` lines — UBI base image digests (dockerfile manager)

## Build Conventions

- Use `Containerfile` (not `Dockerfile`)
- Base images use Red Hat UBI 10; pin to digest where possible
- Multi-stage builds targeting minimal final images (scratch or ubi-micro)
- OpenShift-compatible: run as UID 1001, support arbitrary UID with GID=0
- **Dependency version pinning**: When a package ecosystem provides a declarative dependency file (e.g., `requirements.txt` for Python, `package.json` for npm), use that file to pin versions rather than inline `ARG` + `# renovate:` comments. Only use `# renovate:` ARG annotations for standalone binary downloads that have no ecosystem dependency file.
