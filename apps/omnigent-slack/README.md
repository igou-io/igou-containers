# omnigent-slack

The Omnigent Slack integration, layered onto the pinned upstream server image.
The server image lacks the optional Slack package; the source archive is pinned
by SHA-256 in `Containerfile`.

`apply-native-turn-fix.py` patches the pinned Slack client before installation.
For a managed `opencode-native` session, the native harness reports completion
when it hands the prompt to OpenCode, before OpenCode has answered. The patch
keeps Slack listening past that early ID-less idle and ends on the forwarder's
ID-bearing terminal status. The build runs `test-native-turn.py` to check this
sequence and the in-process harness's ID-less completion. The patch fails the
build if its source anchors change; review it when updating Omnigent.

Renovate tracks the versioned upstream base image and its digest through the
Dockerfile manager. Its version argument also selects the matching Slack source
archive. The seven direct Python requirements are pinned in `requirements.txt`
and tracked by Renovate's pip requirements manager. Updates for this image do
not automerge: when the upstream version changes, refresh the `ADD --checksum`
value from the new archive, then verify the image build and runtime imports.
The build checks that the installed Slack and server package versions match.

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
