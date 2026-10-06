# hermes-agent-k8s

Complete Hermes image built from `david-igou/hermes-agent`'s
`feat/kubernetes-terminal-backend` branch, published as
`ghcr.io/igou-io/hermes-agent-k8s` by igou-containers.

`source.env` pins the full fork commit. `prepare-context.sh` fetches that
snapshot, generates Hermes's canonical install stamp, and adds this directory's
`Containerfile` to the build context. It leaves the fork's `Dockerfile` unchanged.
CI uses the optional preparation hook before the normal image build.

The Containerfile is adapted from the pinned fork's complete Dockerfile. It
retains Debian, the fixed SQLite library, s6 supervision, frontend build, and
PM-managed toolchain so source and runtime stay compatible. This is an exception
to the usual UBI image convention. It adds `kubernetes` and `firecrawl` to the
sealed Python environment using the fork's `pyproject.toml` and `uv.lock`;
runtime installation is unnecessary. No old upstream image or partial module
overlay is used.

## Build and test locally

```bash
context="$(bash apps/hermes-agent-k8s/prepare-context.sh)"
docker build --platform linux/amd64 \
  -f "$context/Containerfile" -t hermes-agent-k8s:test "$context"
bash apps/hermes-agent-k8s/smoke-test.sh hermes-agent-k8s:test
```

The smoke test checks fork provenance, locked SDK versions, Kubernetes backend
imports, and a Firecrawl extraction through the real SDK against a local HTTP
fixture. The container filesystem is read-only and lazy installation is disabled.

## Publish and consume

PR builds validate both `linux/amd64` and `linux/arm64` without publishing.
Main builds publish the normal commit/date/latest tags with provenance and SBOM.
An explicit workflow dispatch can publish an app from a feature branch for
GitOps review; branch builds publish the full igou-containers commit tag without
changing `latest` or date tags. Use the published manifest digest in all three
image references for each HermesInstance (agent, dashboard, and codex-auth-sync).

## Update the fork

Renovate tracks the branch's commit in `source.env`. Review changes to the fork's
Dockerfile when updating the source pin and carry needed recipe changes into this
Containerfile. PM tooling and SDK versions come from the fork lock files; Debian
base digests are managed here by Renovate. SQLite and s6 checksum changes must be
copied with their corresponding version changes from the source recipe.

The Kubernetes terminal backend creates session pods using in-cluster service
account authentication. Configuration stays under `terminal.kubernetes` in
Hermes's config; the image supplies no cluster credentials. SRE's Firecrawl
endpoint, plugin enablement, and NetworkPolicy remain in igou-openshift.
