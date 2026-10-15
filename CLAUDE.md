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

### rust-server

Facepunch Rust dedicated server on Debian 13 slim: the current Unity player
requires glibc 2.35 (UBI 9 has 2.34), and SteamCMD needs a 32-bit loader (removed
from UBI 10). Python provides a small lifecycle
wrapper, WebRCON administration and A2S readiness. Runs as an arbitrary UID with
GID 0 and a read-only root filesystem; all writable state lives under `/data`.
Game files are downloaded on first use and updated only by explicit maintenance
commands. SIGTERM saves and quits through loopback WebRCON, with bounded signal
fallback. `linux/amd64` only. See `apps/rust-server/README.md` for build and
operating commands.

**Dependencies managed by Renovate:** Debian image version/digest and hash-pinned
`requirements.txt`. Valve's unversioned bootstrap archive is checksum-pinned;
SteamCMD and the game update separately in persistent storage.

### hermes-agent-k8s

Complete from-source build of the pinned `david-igou/hermes-agent` Kubernetes
branch. `apps/hermes-agent-k8s/prepare-context.sh` assembles the source context;
the Containerfile and Kubernetes/Firecrawl extras are maintained here. Debian/s6
is retained for compatibility with the fork's PM-managed runtime. Published as
`ghcr.io/igou-io/hermes-agent-k8s` for the three production Hermes instances.
The fork commit is tracked by Renovate in `source.env`; Python/tool dependencies
come from the fork lock files. See the app README for build and smoke-test commands.

### adb-exporter

From-source build of [adb-exporter](https://github.com/david-igou/adb-exporter), a Prometheus exporter for Android devices scraped over the `adb` CLI. UBI 9 based — the runtime needs the `adb` binary, and EPEL packages `android-tools` only for el9 (not el10). Three-stage build:
- Build stage: `ubi9/go-toolset` clones the repo at a Renovate-pinned tag and builds a static binary (`CGO_ENABLED=0`) with version/revision ldflags
- rootfs stage: UBI micro filesystem in a custom installroot + `android-tools` from EPEL 9; its `libprotobuf` dependency is in RHEL AppStream but not UBI's repo subset, so protobuf alone comes from CentOS Stream 9 AppStream (same el9 ABI)
- Final stage: `FROM scratch`, rootfs + binary at `/usr/local/bin/adb-exporter`, UID 1001, port 9836

Runtime note: `HOME=/home/adb-exporter` is group-writable for arbitrary-UID; mount an already-authorized adb key at `~/.android` or the target device will prompt for authorization on first connect.

**Dependencies managed by Renovate:**
- `# renovate:` ARG annotation — pinned adb-exporter release tag (github-tags datasource)
- `FROM` lines — UBI base image digests (dockerfile manager)

### mcp-adc-exporter

From-source build of [mcp-adc-exporter](https://github.com/david-igou/mcp-adc-exporter), a Prometheus exporter for Microchip MCP3xxx SPI ADCs (MCP3004/3008/3204/3208) read over Linux spidev on SBC-class hosts. Two-stage build:
- Build stage: `ubi9/go-toolset` clones the repo at a Renovate-pinned tag and builds a fully static binary (`CGO_ENABLED=0`, pure Go) with version/revision ldflags
- Final stage: `FROM scratch`, UBI 10 micro rootfs + binary at `/usr/local/bin/mcp-adc-exporter`, UID 1001, port 9958

Runtime note: the SPI character device must be passed through and readable, e.g. `podman run --device /dev/spidev0.0 --group-add keep-groups`; the config file is expected at `/etc/mcp-adc-exporter/config.yaml` (override via args).

**Dependencies managed by Renovate:**
- `# renovate:` ARG annotation — pinned mcp-adc-exporter release tag (github-tags datasource)
- `FROM` lines — UBI base image digests (dockerfile manager)

### rigrunner / fangche-runner

Static single-file browser games (Rig Runner and 房车 RUNNER), each an `index.html` vendored into the app directory and served by `nginx-unprivileged:stable-alpine` (listens on 8080, non-root out of the box — the one deliberate deviation from the UBI base convention, since UBI's nginx images require an s2i toolchain for a single static file). Deployed as rootless quadlets on the igou.io VPS at `rigrunner.igou.io` / `fangche.igou.io` (see `igou-inventory/host_vars/igou.io.yml`).

Vendoring is intentional: rigrunner's source of truth is the `rigrunner-fable` parts assembly (workspace scratch), and fangche-runner lives on lab-internal Forgejo (`sandbox/fangche-runner`) which GitHub Actions cannot reach. To update a game, replace its `index.html` here.

**Dependencies managed by Renovate:**
- `FROM` lines — nginx-unprivileged digest (dockerfile manager)

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
