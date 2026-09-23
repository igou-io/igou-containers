package openshell

// ACP's pinned upstream revision maps unknown provider types to generic.
// Preserve the OpenCode profile ID so OpenShell can bind the API key to its
// declared endpoint instead of treating the provider as profileless.
func init() {
	providerTypeMapping["opencode-go-codex"] = "opencode-go-codex"
}
