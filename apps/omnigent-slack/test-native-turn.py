"""Build-time regression checks for the pinned Slack stream patch."""

import asyncio
from contextlib import asynccontextmanager
import unittest

from omnigent_slack.omnigent import OmnigentClient, SessionInfo


class NativeTurnTest(unittest.IsolatedAsyncioTestCase):
    async def run_stream(self, harness: str, events: list[dict]) -> list[str]:
        client = OmnigentClient("http://omnigent.test")
        submissions = []

        async def session_info(_session_id: str) -> SessionInfo:
            return SessionInfo(harness=harness, agent_name="igou-sre")

        async def submit(_session_id: str, message: str) -> None:
            submissions.append(message)

        @asynccontextmanager
        async def stream(_session_id: str):
            async def source():
                for event in events:
                    yield event
                    await asyncio.sleep(0)
                await asyncio.sleep(30)

            yield source()

        client.get_session_info = session_info
        client.submit_message = submit
        client.stream_session_events = stream
        try:
            deltas = await asyncio.wait_for(
                self._collect(client), timeout=2
            )
        finally:
            await client.aclose()
        self.assertEqual(submissions, ["run cat /etc/redhat-release"])
        return deltas

    @staticmethod
    async def _collect(client: OmnigentClient) -> list[str]:
        return [
            event["delta"]
            async for event in client.run_turn(
                "session_1", "run cat /etc/redhat-release", host_type="managed"
            )
            if event.get("type") == "response.output_text.delta"
        ]

    async def test_native_prompt_handoff_does_not_end_slack_turn(self) -> None:
        deltas = await self.run_stream(
            "opencode-native",
            [
                {"type": "session.status", "status": "running"},
                {"type": "response.completed", "response": {"status": "completed"}},
                {"type": "session.status", "status": "idle"},
                {"type": "session.status", "status": "running", "response_id": "msg_1"},
                {"type": "response.output_text.delta", "delta": "CentOS Stream release 10"},
                {"type": "session.status", "status": "idle", "response_id": "msg_1"},
            ],
        )
        self.assertEqual(deltas, ["CentOS Stream release 10"])

    async def test_in_process_idless_idle_still_ends_turn(self) -> None:
        deltas = await self.run_stream(
            "claude-sdk",
            [
                {"type": "session.status", "status": "running"},
                {"type": "response.completed", "response": {"status": "completed"}},
                {"type": "session.status", "status": "idle"},
            ],
        )
        self.assertEqual(deltas, [])

    async def test_native_setup_failure_still_ends_turn(self) -> None:
        deltas = await self.run_stream(
            "opencode-native",
            [
                {"type": "session.status", "status": "running"},
                {"type": "session.status", "status": "failed"},
            ],
        )
        self.assertEqual(deltas, [])


if __name__ == "__main__":
    unittest.main()
