# ACP OpenCode provider mapping

This image rebuilds the pinned upstream Agent Control Plane control-plane binary
with one additive mapping: ACP provider type `opencode-go-codex` becomes the
OpenShell profile ID `opencode-go-codex` instead of `generic`. The dedicated
`acp-poc` gateway imports the matching, endpoint-bound profile from
`igou-openshift/applications/openshell/provider-profiles/opencode-go-codex.yaml`.
The API key remains in the `acp-poc` Kubernetes Secret and OpenShell's encrypted
provider store; it is not built into this image.

The upstream source revision, builder, and runtime image are pinned in the
Containerfile. Reassess this overlay when upgrading ACP: if upstream supports
custom provider types directly, remove the override and use the upstream image.
