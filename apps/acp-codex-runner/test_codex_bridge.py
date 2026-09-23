import asyncio
import json
import os
import unittest
from unittest.mock import patch

from ag_ui.core import EventType
from ambient_runner.endpoints.run import RunnerInput

from codex_bridge import CodexBridge


class CodexBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_codex_success_emits_complete_agui_run(self):
        class FakeProcess:
            returncode = 0

            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stderr = asyncio.StreamReader()
                for item in (
                    {"type": "thread.started", "thread_id": "codex-thread-1"},
                    {"type": "item.completed", "item": {"type": "agent_message", "text": "OK"}},
                    {"type": "turn.completed"},
                ):
                    self.stdout.feed_data((json.dumps(item) + "\n").encode())
                self.stdout.feed_eof()
                self.stderr.feed_eof()

            async def wait(self):
                return 0

        input_data = RunnerInput(
            threadId="acp-thread", messages=[{"id": "user-1", "role": "user", "content": "Reply OK"}]
        ).to_run_agent_input()
        bridge = CodexBridge()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "dummy", "WORKSPACE_PATH": "/sandbox/workspace"}), \
             patch("asyncio.create_subprocess_exec", return_value=FakeProcess()) as spawn:
            events = [event async for event in bridge.run(input_data)]
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
        self.assertEqual(events[2].type, EventType.TEXT_MESSAGE_CONTENT)
        self.assertEqual(events[2].delta, "OK")
        args = spawn.call_args.args
        self.assertEqual(args[:3], ("codex", "exec", "--json"))
        self.assertNotIn("dummy", " ".join(args))

    async def test_translates_assistant_and_tracks_resume_id(self):
        stream = asyncio.StreamReader()
        for item in (
            {"type": "thread.started", "thread_id": "codex-thread-1"},
            {"type": "item.completed", "item": {"type": "agent_message", "id": "msg-1", "text": "OK"}},
        ):
            stream.feed_data((json.dumps(item) + "\n").encode())
        stream.feed_eof()
        bridge = CodexBridge()
        events = [event async for event in bridge._codex_events(stream, "acp-thread", "run-1")]
        self.assertEqual(
            [event.type for event in events],
            [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END],
        )
        self.assertEqual(events[1].delta, "OK")
        self.assertEqual(bridge._codex_threads["acp-thread"], "codex-thread-1")

    async def test_missing_provider_key_is_a_run_error(self):
        input_data = RunnerInput(
            threadId="acp-thread", messages=[{"id": "user-1", "role": "user", "content": "Reply OK"}]
        ).to_run_agent_input()
        bridge = CodexBridge()
        with patch.dict(os.environ, {}, clear=True):
            events = [event async for event in bridge.run(input_data)]
        self.assertEqual(events[0].type, EventType.RUN_STARTED)
        self.assertEqual(events[1].type, EventType.RUN_ERROR)
        self.assertIn("OPENAI_API_KEY", events[1].message)


if __name__ == "__main__":
    unittest.main()
