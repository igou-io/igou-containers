# Google Drive MCP

Piotr Agier's Google Drive MCP server, installed from the pinned npm release
and dependency lockfile. The UBI Node.js runtime supports OpenShift's arbitrary
non-root UID and a read-only root filesystem with writable `/tmp`.

The default command serves Streamable HTTP on port 3100 at `/mcp`. This mode
uses one Google identity and does not authenticate MCP callers. Keep it private
and restrict callers with NetworkPolicy.

Mount the service-account JSON read-only and set `GOOGLE_APPLICATION_CREDENTIALS`
to its path. Set `GOOGLE_DRIVE_MCP_SCOPES` explicitly for the needed APIs; no
domain-wide delegation is required. Configuration and cache files use `/tmp`.

Renovate manages the upstream npm release, transitive lockfile dependencies,
and the base image digest. Runtime credentials must never enter the build context.

Operational deployment and verification live in `igou-docs`.

## Dependency compatibility patch

Upstream 2.13.0 depends on Zod 3, affected by GHSA-mrhx-c7xc-m3w5. Override it
with patched Zod 4.6.7 and adapt the two renamed APIs in the installed bundle:
`error.errors` becomes `error.issues`, and `required_error` becomes `error`.
The patch checks replacement counts and fails the build if upstream changes.
The same changes passed all 1,222 tests in the upstream source checkout.

Gaxios is overridden to 8.3.2, removing its old Rimraf/Glob dependency chain.
Review these overrides and retire the compatibility patch when upstream adopts
the fixed dependencies. `npm audit --omit=dev` checks the locked runtime graph.
