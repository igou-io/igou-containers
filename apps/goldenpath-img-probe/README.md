# goldenpath-img-probe

container-image PR e2e probe

Scaffolded by the container-image golden path into `apps/goldenpath-img-probe/`.

- **Build**: CI (`build-containers.yml`) auto-detects changes to this
  directory; PRs build without pushing, merges to `main` push
  `ghcr.io/igou-io/goldenpath-img-probe` (`latest`, date, SHA, branch tags)
  with provenance attestation and SBOM.
- **Platforms**: linux/amd64 + linux/arm64 by default; restrict with a
  `PLATFORMS` file in this directory if needed.
- **Renovate**: pins `FROM` digests after merge; add `# renovate:` ARG
  annotations for upstream release tags you want tracked.
- **Document the image** in the repo-root `AGENTS.md` "Current Apps"
  section (build pattern, runtime notes) — see existing entries.
