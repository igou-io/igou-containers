# zfs-exporter

[pdf/zfs_exporter](https://github.com/pdf/zfs_exporter) plus the OpenZFS userland CLI (`zfs`/`zpool`) on UBI 10 minimal, for Prometheus monitoring of the TrueNAS host (igou-io/igou-containers#81).

## Image notes

- **UBI minimal base, userland-only ZFS**: RHEL/UBI ships no zfs packages, so the signed RPMs come from the [OpenZFS EL10 repo](https://zfsonlinux.org). The `zfs` package hard-requires `zfs-kmod`/`sysstat`/`systemd` (host concerns — the kernel module is the host's, reached via `/dev/zfs`), so the CLI + libs are installed with `rpm --nodeps --noscripts` after GPG signature verification, and an `ldd` check gates the build on real shared-library deps.
- **OpenZFS version**: pinned to the 2.3 line (Renovate-managed, capped at `<2.4` in `renovate.json`) to match the TrueNAS 25.10 host kmod. EL10 stable still carries 2.2, so packages come from the `zfs-testing` repo.
- **amd64 only** (`PLATFORMS` file): OpenZFS publishes no aarch64 EL packages.
- **Non-root**: runs as `65534:65534` — read-only `zfs`/`zpool` ioctls need no root and `/dev/zfs` is mode 0666 on TrueNAS.

## Runtime contract

```yaml
services:
  zfs-exporter:
    image: ghcr.io/igou-io/zfs-exporter:latest@sha256:<pin>
    devices:
      - /dev/zfs:/dev/zfs      # all it needs — no privileged, no host mounts
    ports:
      - "9134:9134"
```

Upstream defaults are sensible: pool + dataset-filesystem + dataset-volume collectors on, snapshot collector off (cardinality), `--deadline=8s` with cached fallback. Metrics at `:9134/metrics`.

Tags are `latest`/date/SHA (no semver) — pin consumers as `latest@sha256:…` and ride Renovate digest updates.
