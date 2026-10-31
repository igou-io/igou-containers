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
