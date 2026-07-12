# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

Monorepo for building container images, pushed to GHCR (`ghcr.io/igou-io/<app>`). Each app lives under `apps/<app-name>/` with its own `Containerfile` and build context.

## CI/CD

GitHub Actions workflow (`.github/workflows/build-containers.yml`) automatically detects which `apps/` subdirectories changed and builds only those. Images are built for `linux/amd64` and `linux/arm64`, pushed on merge to `main`. PRs get build-only (no push).

Image tags: `latest`, `YYYY.MM.DD`, full commit SHA, and branch name.

Apps that can't build for all default platforms declare their own in an `apps/<app>/PLATFORMS` file (e.g. `zfs-exporter` is `linux/amd64` only — OpenZFS publishes no aarch64 EL packages).

## Adding a New App

1. Create `apps/<app-name>/` with a `Containerfile` and any build context files.
2. The CI workflow will automatically pick it up on the next push that touches that directory.

## Current Apps

### adb-exporter

From-source build of [adb-exporter](https://github.com/david-igou/adb-exporter), a Prometheus exporter for Android devices scraped over the `adb` CLI. UBI 9 based — the runtime needs the `adb` binary, and EPEL packages `android-tools` only for el9 (not el10). Three-stage build:
- Build stage: `ubi9/go-toolset` clones the repo at a Renovate-pinned tag and builds a static binary (`CGO_ENABLED=0`) with version/revision ldflags
- rootfs stage: UBI micro filesystem in a custom installroot + `android-tools` from EPEL 9; its `libprotobuf` dependency is in RHEL AppStream but not UBI's repo subset, so protobuf alone comes from CentOS Stream 9 AppStream (same el9 ABI)
- Final stage: `FROM scratch`, rootfs + binary at `/usr/local/bin/adb-exporter`, UID 1001, port 9836

Runtime note: `HOME=/home/adb-exporter` is group-writable for arbitrary-UID; mount an already-authorized adb key at `~/.android` or the target device will prompt for authorization on first connect.

**Dependencies managed by Renovate:**
- `# renovate:` ARG annotation — pinned adb-exporter release tag (github-tags datasource)
- `FROM` lines — UBI base image digests (dockerfile manager)

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

### opencode

Hardened UBI10-based container for running [opencode](https://opencode.ai) against a local llama.cpp / vLLM endpoint (or any OpenAI-compatible provider). Same three-stage build pattern as cursor-agent-cli:
- Stage 1: UBI micro base filesystem
- Stage 2: UBI full image installs system packages, CLI tools, and Python packages into a custom installroot
- opencode build stage: installs the opencode binary via the upstream installer (`https://opencode.ai/install`) as UID 1000 — drops at `~/.opencode/bin/opencode`
- Final stage: `FROM scratch`, copies rootfs + opencode binary

No baked sandbox config (opencode has no equivalent of Claude's `settings.json` or Cursor's `sandbox.json`), so the entrypoint is a minimal git/GitHub PAT setup with no merge step. The opencode config lives in `~/.config/opencode/opencode.jsonc` on the host and is bind-mounted into the container by the `opencode-run` launcher in `igou-devenv/bin/`.

**Dependencies managed by Renovate:**
- `requirements.txt` — Python packages (pip_requirements manager)
- `# renovate:` ARG annotations — CLI tool binary versions (custom regex manager)
- `FROM` lines — UBI base image digests (dockerfile manager)

### opencode-dev

Unhardened sibling of the `opencode` image. Identical build pattern, but two intentional differences from the hardened variant:

- `pip`/`pip3`/ensurepip are **not** removed — the agent can `pip install --user <pkg>` at runtime.
- [uv](https://github.com/astral-sh/uv) is baked in at `/usr/local/bin/uv` (copied from `ghcr.io/astral-sh/uv:<version>` via the dockerfile manager — Renovate updates the tag automatically).

Use this image when you need the agent to install ad-hoc Python packages mid-task. Launch via `opencode-run --dev` (which sets `IMAGE=ghcr.io/igou-io/opencode-dev:latest`) or `opencode-run --image ghcr.io/igou-io/opencode-dev:latest`. Runtime hardening (cap-drop, noexec /tmp, resource limits) is unchanged — only the image-level package-manager removal is reverted. The image's `TMPDIR` is set to `/home/igou/.cache` so pip and uv can use an exec-able scratch dir.

**Dependencies managed by Renovate:**
- `requirements.txt` — Python packages (pip_requirements manager)
- `# renovate:` ARG annotations — CLI tool binary versions (custom regex manager)
- `FROM` and `COPY --from=` lines — base images and uv tag (dockerfile manager)

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

### zfs-exporter

[pdf/zfs_exporter](https://github.com/pdf/zfs_exporter) plus the OpenZFS userland CLI on UBI 10 minimal, for Prometheus monitoring of the TrueNAS host (#81). Three-stage build:
- Fetch stage: downloads the zfs_exporter release binary, verified against upstream `sha256sums.txt`
- RPM stage: UBI full downloads signed OpenZFS EL10 RPMs (2.3 line from `zfs-testing` — EL10 stable is still 2.2; 2.3 matches the TrueNAS 25.10 host kmod)
- Final stage: UBI minimal installs the userland CLI + libs via `rpm --nodeps --noscripts` after GPG verification (the kmod/sysstat/systemd requirements are host concerns), gated by an `ldd` check

`linux/amd64` only (see `PLATFORMS` file). Runs as 65534; needs only `/dev/zfs` passed through at runtime.

**Dependencies managed by Renovate:**
- `# renovate:` ARG annotations — zfs_exporter release and OpenZFS version (capped `<2.4.0` via packageRule in `renovate.json` to track the host's 2.3 line)
- `FROM` lines — UBI base image digests (dockerfile manager)

### squid

[Squid](https://www.squid-cache.org/) forward proxy from UBI 10 AppStream on UBI 10 minimal, built for OpenShift: single-stage, arbitrary-UID compatible (GID 0 group perms, `USER 1001:0`), foreground squid with access log on stdout and cache/debug on stderr, memory-only cache, no pid file, 5s shutdown for fast pod termination. Config baked at `/etc/squid/squid.conf` (allow RFC1918/ULA clients to 80/443 only); override by mounting a ConfigMap over it.

**Dependencies managed by Renovate:**
- `FROM` lines — UBI base image digests (dockerfile manager)

## Build Conventions

- Use `Containerfile` (not `Dockerfile`)
- Base images use Red Hat UBI 10; pin to digest where possible
- Multi-stage builds targeting minimal final images (scratch or ubi-micro)
- OpenShift-compatible: run as UID 1001, support arbitrary UID with GID=0
- **Dependency version pinning**: When a package ecosystem provides a declarative dependency file (e.g., `requirements.txt` for Python, `package.json` for npm), use that file to pin versions rather than inline `ARG` + `# renovate:` comments. Only use `# renovate:` ARG annotations for standalone binary downloads that have no ecosystem dependency file.
