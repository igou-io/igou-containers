"""Translate Codex CLI JSONL into ACP's AG-UI runner contract."""

import asyncio
import json
import logging
import os
import uuid
from collections.abc import AsyncIterator

from ag_ui.core import (
    BaseEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from ambient_runner.bridge import FrameworkCapabilities, PlatformBridge
from ambient_runner.bridges.claude.grpc_transport import GRPCSessionListener
from ag_ui_gemini_cli.utils import extract_user_message

logger = logging.getLogger(__name__)


class CodexBridge(PlatformBridge):
    def __init__(self) -> None:
        super().__init__()
        self._grpc_listener: GRPCSessionListener | None = None
        self._active_streams: dict[str, asyncio.Queue] = {}
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._codex_threads: dict[str, str] = {}
        self._model = os.getenv("LLM_MODEL") or os.getenv("CODEX_MODEL", "gpt-5.6-luna")

    def capabilities(self) -> FrameworkCapabilities:
        return FrameworkCapabilities(
            framework="codex",
            agent_features=["agentic_chat", "backend_tool_rendering"],
            file_system=True,
            session_persistence=True,
        )

    @property
    def configured_model(self) -> str:
        return self._model

    async def start_grpc_listener(self, grpc_url: str) -> None:
        if self._context is None:
            raise RuntimeError("runner context is not initialized")
        self._grpc_listener = GRPCSessionListener(
            bridge=self, session_id=self._context.session_id, grpc_url=grpc_url
        )
        self._grpc_listener.start()

    async def shutdown(self) -> None:
        if self._grpc_listener:
            await self._grpc_listener.stop()
        await self.interrupt()

    async def interrupt(self, thread_id: str | None = None) -> None:
        if self._process and self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()

    async def run(self, input_data: RunAgentInput, **kwargs) -> AsyncIterator[BaseEvent]:
        thread_id = input_data.thread_id or self._context.session_id
        run_id = input_data.run_id or str(uuid.uuid4())
        prompt = extract_user_message(input_data).strip()
        yield RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id)
        if not prompt:
            yield RunErrorEvent(type=EventType.RUN_ERROR, thread_id=thread_id, run_id=run_id,
                                message="No user prompt was supplied")
            return
        if not os.getenv("OPENAI_API_KEY"):
            yield RunErrorEvent(type=EventType.RUN_ERROR, thread_id=thread_id, run_id=run_id,
                                message="OPENAI_API_KEY provider credential is unavailable")
            return

        provider = os.getenv("CODEX_MODEL_PROVIDER", "opencode_go")
        base_url = os.getenv("CODEX_BASE_URL", "https://opencode.ai/zen/go/v1")
        workspace = os.getenv("WORKSPACE_PATH", "/sandbox/workspace")
        config = [
            "-c", f"model_provider={json.dumps(provider)}",
            "-c", f"model_providers.{provider}.name={json.dumps(provider)}",
            "-c", f"model_providers.{provider}.base_url={json.dumps(base_url)}",
            "-c", f"model_providers.{provider}.env_key=\"OPENAI_API_KEY\"",
            "-c", f"model_providers.{provider}.wire_api=\"responses\"",
        ]
        command = ["codex", "exec", "--json", "--ignore-user-config",
                   "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
                   "-m", self._model, *config]
        previous = self._codex_threads.get(thread_id)
        if previous:
            command.extend(["resume", "--json", previous, prompt])
        else:
            command.append(prompt)

        async with self._lock:
            self._process = await asyncio.create_subprocess_exec(
                *command, cwd=workspace, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stderr_task = asyncio.create_task(self._process.stderr.read())
            message_count = 0
            failed = False
            try:
                async for event in self._codex_events(self._process.stdout, thread_id, run_id):
                    if isinstance(event, TextMessageEndEvent):
                        message_count += 1
                    if isinstance(event, RunErrorEvent):
                        failed = True
                    yield event
                exit_code = await self._process.wait()
                await stderr_task
                if exit_code != 0 and not failed:
                    failed = True
                    yield RunErrorEvent(type=EventType.RUN_ERROR, thread_id=thread_id,
                                        run_id=run_id, message=f"Codex exited with status {exit_code}")
                if not failed and message_count == 0:
                    failed = True
                    yield RunErrorEvent(type=EventType.RUN_ERROR, thread_id=thread_id,
                                        run_id=run_id, message="Codex returned no assistant message")
                if not failed:
                    yield RunFinishedEvent(type=EventType.RUN_FINISHED,
                                           thread_id=thread_id, run_id=run_id)
            finally:
                await self.interrupt(thread_id)
                self._process = None

    async def _codex_events(self, stream: asyncio.StreamReader, thread_id: str,
                            run_id: str) -> AsyncIterator[BaseEvent]:
        async for line in stream:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Ignoring malformed Codex JSONL event")
                continue
            kind = item.get("type")
            if kind == "thread.started" and item.get("thread_id"):
                self._codex_threads[thread_id] = item["thread_id"]
            elif kind == "item.completed" and item.get("item", {}).get("type") == "agent_message":
                content = item["item"].get("text", "")
                if content:
                    message_id = item["item"].get("id") or str(uuid.uuid4())
                    yield TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START,
                                                message_id=message_id, role="assistant")
                    yield TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT,
                                                  message_id=message_id, delta=content)
                    yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END,
                                              message_id=message_id)
            elif kind == "turn.failed":
                yield RunErrorEvent(type=EventType.RUN_ERROR, thread_id=thread_id,
                                    run_id=run_id, message="Codex turn failed")
