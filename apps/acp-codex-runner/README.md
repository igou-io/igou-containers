# ACP Codex runner

This image extends the pinned ACP OpenShell runner with the Codex CLI and an
AG-UI bridge. It reuses ACP's gRPC session listener so initial and subsequent
user messages become durable ACP messages. Codex JSONL assistant messages are
translated to AG-UI text events and written back through that listener.

The runner expects `OPENAI_API_KEY` from an OpenShell provider, and uses
`https://opencode.ai/zen/go/v1` with `gpt-5.6-luna` by default. It does not
embed credentials. Its internal Codex sandbox is disabled because the enclosing
OpenShell sandbox supplies the filesystem and network boundary. This is a POC
using ordinary containers, not a production isolation boundary.

The image is pinned to ACP revision
`9d7246cb467b3e4d4060bff760b6256f6a368a50`; update the bridge and its
tests alongside any upstream runner image change.
