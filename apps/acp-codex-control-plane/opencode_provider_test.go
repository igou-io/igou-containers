package openshell

import "testing"

func TestOpenCodeProviderMapping(t *testing.T) {
	if got := OpenShellProviderType("opencode-go-codex"); got != "opencode-go-codex" {
		t.Fatalf("OpenShellProviderType(opencode-go-codex) = %q", got)
	}
	if got := ProviderCredentialsFromSecret("opencode-go-codex", map[string]string{"OPENAI_API_KEY": "test-value"}); got["OPENAI_API_KEY"] != "test-value" {
		t.Fatalf("OpenCode provider credential key not passed through")
	}
}
