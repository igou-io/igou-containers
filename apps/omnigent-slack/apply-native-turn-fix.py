"""Keep Slack attached to OpenCode after the native harness accepts a prompt.

Apply to the pinned Omnigent source archive before installing its Slack package.
Each anchor must match once so an upstream source change fails the image build.
"""

from pathlib import Path
import sys


source = Path(sys.argv[1]) / "integrations/slack/src/omnigent_slack/omnigent.py"
code = source.read_text()


def replace_once(old: str, new: str) -> None:
    global code
    count = code.count(old)
    if count != 1:
        raise SystemExit(f"Expected one source anchor, found {count}: {old[:80]!r}")
    code = code.replace(old, new, 1)


replace_once(
    """        try:
            async for event in self._run_turn_once(session_id, text, idle_grace_seconds):
""",
    """        # The native harness completes when it hands the prompt to OpenCode.
        # Its scaffold completion and id-less idle precede the real answer.
        native_managed_turn = False
        if host_type == "managed":
            info = await self.get_session_info(session_id)
            native_managed_turn = info.harness == "opencode-native"
        try:
            async for event in self._run_turn_once(
                session_id, text, idle_grace_seconds, native_managed_turn
            ):
""",
)
replace_once(
    """        async for event in self._run_turn_once(session_id, text, idle_grace_seconds):
            yield event

    async def _run_turn_once(
""",
    """        async for event in self._run_turn_once(
            session_id, text, idle_grace_seconds, native_managed_turn
        ):
            yield event

    async def _run_turn_once(
""",
)
replace_once(
    """        text: str,
        idle_grace_seconds: float,
    ) -> AsyncIterator[dict[str, Any]]:
""",
    """        text: str,
        idle_grace_seconds: float,
        native_managed_turn: bool,
    ) -> AsyncIterator[dict[str, Any]]:
""",
)
replace_once(
    """                                    and not saw_open_running
                                    and produced_or_failed
                                )
""",
    """                                    and not saw_open_running
                                    and produced_or_failed
                                    and (not native_managed_turn or status == "failed")
                                )
""",
)
source.write_text(code)
