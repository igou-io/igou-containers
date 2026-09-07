# calibre-web

OpenShift-compatible Calibre-Web image for the ebook library service

Scaffolded by the container-image golden path into `apps/calibre-web/`.

- **Build**: CI (`build-containers.yml`) auto-detects changes to this
  directory; PRs build without pushing, merges to `main` push
  `ghcr.io/igou-io/calibre-web` (`latest`, date, SHA, branch tags)
  with provenance attestation and SBOM.
- **Platforms**: linux/amd64 + linux/arm64 by default; restrict with a
  `PLATFORMS` file in this directory if needed.
- **Renovate**: pins `FROM` digests after merge; add `# renovate:` ARG
  annotations for upstream release tags you want tracked.
- **Document the image** in the repo-root `AGENTS.md` "Current Apps"
  section (build pattern, runtime notes) — see existing entries.
