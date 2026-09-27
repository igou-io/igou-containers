# omnigent-slack

The unmodified Omnigent v0.15.0 Slack integration, layered onto the pinned
upstream server image. The server image lacks the optional Slack package; the
source archive is pinned by SHA-256 in `Containerfile`.

Build locally from the repository root:

```bash
podman build -t localhost/omnigent-slack:v0.15.0 apps/omnigent-slack
```

The standard container workflow builds both `linux/amd64` and `linux/arm64` on
the PR. A merge to `main` publishes `ghcr.io/igou-io/omnigent-slack` with the
normal branch, commit, date and `latest` tags. The OpenShift Deployment should
use the published multi-architecture manifest digest once available; do not
replace its existing Quay digest with an unpublished GHCR reference.

The Deployment supplies the bot and app tokens, device-client secret, HTTPS
server URL, proxy settings and persistent SQLite volume. None are built into
this image. The container starts `omni integration slack` in the foreground.
