"""ACP-compatible AG-UI server backed by the Codex CLI."""

from ambient_runner import create_ambient_app

from codex_bridge import CodexBridge

app = create_ambient_app(CodexBridge(), title="ACP Codex Runner")
