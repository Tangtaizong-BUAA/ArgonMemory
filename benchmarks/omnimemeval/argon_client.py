"""OmniMemEval adapter for Argon Memory's public MCP boundary."""

from __future__ import annotations

import atexit
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MCP_PROTOCOL_VERSION = "2025-06-18"
ADAPTER_VERSION = "0.1.0"


def _require(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"{name} must be a non-empty string")
    return value.strip()


def _safe(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")
    return (cleaned or "memory")[:100]


def _project_id(user_id: str) -> str:
    digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:20]
    return f"project:omnimemeval-{digest}"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class _McpClient:
    def __init__(self, url: str, bearer_token: str | None = None) -> None:
        self.url = url
        self.bearer_token = bearer_token
        self.session_id: str | None = None
        self._next_id = 1
        self._lock = threading.RLock()
        self._initialize()

    @staticmethod
    def _decode(raw: bytes, content_type: str) -> dict[str, Any] | None:
        if not raw.strip():
            return None
        text = raw.decode("utf-8")
        if "text/event-stream" in content_type:
            lines = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
            if not lines:
                raise RuntimeError("Argon MCP returned an empty event stream")
            text = lines[-1]
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise RuntimeError("Argon MCP response is not an object")
        return payload

    def _request(self, method: str, params: dict[str, Any] | None, *, notification: bool = False) -> dict[str, Any] | None:
        with self._lock:
            request_id = None if notification else self._next_id
            if not notification:
                self._next_id += 1
            payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
            if request_id is not None:
                payload["id"] = request_id
            if params is not None:
                payload["params"] = params
            headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
            if self.session_id:
                headers["Mcp-Session-Id"] = self.session_id
            if self.bearer_token:
                headers["Authorization"] = f"Bearer {self.bearer_token}"
            request = Request(
                self.url,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            try:
                with urlopen(request, timeout=180) as response:
                    if response.headers.get("Mcp-Session-Id"):
                        self.session_id = response.headers["Mcp-Session-Id"]
                    decoded = self._decode(response.read(), response.headers.get("Content-Type", "application/json"))
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"Argon MCP HTTP {exc.code}: {detail[:1000]}") from exc
            except URLError as exc:
                raise RuntimeError(f"Could not reach Argon MCP at {self.url}: {exc}") from exc
            if decoded and "error" in decoded:
                raise RuntimeError(f"Argon MCP error: {decoded['error']}")
            return decoded

    def _initialize(self) -> None:
        response = self._request(
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "argon-omnimemeval", "version": ADAPTER_VERSION},
            },
        )
        if response is None or not isinstance(response.get("result"), dict):
            raise RuntimeError("Argon MCP initialize failed")
        self._request("notifications/initialized", {}, notification=True)

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = self._request("tools/call", {"name": name, "arguments": arguments})
        if response is None or not isinstance(response.get("result"), dict):
            raise RuntimeError(f"Argon MCP returned no result for {name}")
        result = response["result"]
        if result.get("isError"):
            raise RuntimeError(f"Argon tool {name} failed: {result.get('content')}")
        structured = result.get("structuredContent")
        return structured if isinstance(structured, dict) else result


class ArgonClient:
    """Expose Argon as OmniMemEval's shared ``add`` / ``search`` backend.

    Every OmniMemEval ``user_id`` maps to an isolated Argon project. The
    adapter intentionally uses MCP instead of importing Argon internals.
    """

    def __init__(self) -> None:
        self.root = Path(os.environ.get("ARGON_OMNI_KB_ROOT", "/tmp/argon-omnimemeval-kb")).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.cli = Path(_require(os.environ.get("ARGON_MEMORY_CLI"), "ARGON_MEMORY_CLI")).expanduser().resolve()
        if not self.cli.is_file():
            raise RuntimeError(f"Argon Memory CLI is missing: {self.cli}")
        self.external_url = os.environ.get("ARGON_MEMORY_MCP_URL", "").strip() or None
        self.token = os.environ.get("ARGON_MEMORY_TOKEN", "").strip() or None
        self.context_max_tokens = max(800, min(int(os.environ.get("ARGON_OMNI_CONTEXT_MAX_TOKENS", "16000")), 40000))
        self._process: subprocess.Popen[str] | None = None
        self._log_handle: Any | None = None
        self._url: str | None = None
        self._clients = threading.local()
        self._lock = threading.RLock()
        self._work_ids: dict[str, str] = {}
        self._sequence = 0
        atexit.register(self.close)

    def _start(self) -> None:
        with self._lock:
            if self._url:
                return
            if self.external_url:
                self._url = self.external_url
                return
            port = _free_port()
            log_path = self.root / "omnimemeval-argon-server.log"
            self._log_handle = log_path.open("a", encoding="utf-8")
            env = os.environ.copy()
            env.update({
                "ARGON_MEMORY_HOST": "127.0.0.1",
                "ARGON_MEMORY_PORT": str(port),
                "ARGON_MEMORY_KB_ROOT": str(self.root),
                "ARGON_MEMORY_MCP_PROFILE": "project-ops",
                "ARGON_MEMORY_ALLOW_UNAUTHENTICATED": "true",
            })
            self._process = subprocess.Popen(
                [os.environ.get("NODE_BINARY", "node"), str(self.cli)],
                env=env,
                stdout=self._log_handle,
                stderr=self._log_handle,
                text=True,
            )
            health_url = f"http://127.0.0.1:{port}/health"
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if self._process.poll() is not None:
                    raise RuntimeError(f"Argon MCP exited early; see {log_path}")
                try:
                    with urlopen(health_url, timeout=1) as response:
                        if response.status == 200:
                            self._url = f"http://127.0.0.1:{port}/mcp"
                            return
                except (URLError, TimeoutError):
                    time.sleep(0.1)
            raise RuntimeError(f"Timed out starting Argon MCP; see {log_path}")

    def _client(self) -> _McpClient:
        self._start()
        client = getattr(self._clients, "client", None)
        if client is None:
            client = _McpClient(_require(self._url, "Argon MCP URL"), self.token if self.external_url else None)
            self._clients.client = client
        return client

    def _ensure_work(self, user_id: str) -> tuple[str, str]:
        project_id = _project_id(user_id)
        with self._lock:
            if project_id in self._work_ids:
                return project_id, self._work_ids[project_id]
            client = self._client()
            client.call_tool(
                "kb_bootstrap_project",
                {
                    "project_id": project_id,
                    "title": f"OmniMemEval user {_safe(user_id)}",
                    "mission": "Persist and retrieve public benchmark conversation evidence under an isolated user scope.",
                },
            )
            started = client.call_tool(
                "kb_start_work",
                {
                    "project_id": project_id,
                    "objective": "Index public OmniMemEval benchmark conversations",
                    "expected_outputs": ["searchable conversation artifacts"],
                    "acceptance_criteria": ["all submitted messages retain role, order, time, and provenance"],
                    "input_refs": ["benchmark:omnimemeval", f"user:{user_id}"],
                },
            )
            work_id = _require(started.get("work_id"), "kb_start_work work_id")
            self._work_ids[project_id] = work_id
            return project_id, work_id

    @staticmethod
    def _render_messages(messages: Any, user_id: str, metadata: dict[str, Any]) -> str:
        if not isinstance(messages, list) or not messages:
            raise ValueError("ArgonClient.add requires a non-empty message list")
        lines = ["# Conversation memory", "", f"- Benchmark user: `{user_id}`"]
        for key in ("conv_id", "session_id", "session_key", "timestamp"):
            value = metadata.get(key)
            if value is not None:
                lines.append(f"- {key}: `{value}`")
        lines.extend(["", "## Ordered messages"])
        for index, message in enumerate(messages, start=1):
            if not isinstance(message, dict):
                raise ValueError("Each message must be an object")
            role = str(message.get("role") or "unknown")
            content = str(message.get("content") or "").strip()
            if not content:
                continue
            lines.extend(["", f"### Message {index} · {role}"])
            chat_time = message.get("chat_time")
            if chat_time:
                lines.append(f"Time: {chat_time}")
            lines.extend(["", content])
        return "\n".join(lines).strip() + "\n"

    def add(self, messages: Any, user_id: str, **kwargs: Any) -> None:
        project_id, work_id = self._ensure_work(user_id)
        markdown = self._render_messages(messages, user_id, kwargs)
        with self._lock:
            self._sequence += 1
            sequence = self._sequence
        digest = hashlib.sha256(markdown.encode("utf-8")).hexdigest()[:16]
        result = self._client().call_tool(
            "kb_publish_resource",
            {
                "work_id": work_id,
                "resource": {
                    "title": f"OmniMemEval conversation {sequence}",
                    "filename": f"{_safe(user_id)}-{sequence:05d}-{digest}.md",
                    "content_type": "text/markdown",
                    "encoding": "utf8",
                    "content": markdown,
                    "kind": "document",
                    "source_refs": ["benchmark:omnimemeval", f"project:{project_id}", f"user:{user_id}"],
                    "confidentiality": "internal",
                },
            },
        )
        if not result.get("artifact_id"):
            raise RuntimeError("Argon did not return an artifact_id")

    def search(self, query: str, user_id: str, top_k: int, **_kwargs: Any) -> str:
        project_id = _project_id(user_id)
        searched = self._client().call_tool(
            "kb_search",
            {
                "project_id": project_id,
                "query": query,
                "top_k": max(1, min(int(top_k), 20)),
                "include_unverified": False,
            },
        )
        raw_rows = searched.get("results")
        rows = [row for row in raw_rows if isinstance(row, dict) and row.get("type") == "artifact"] if isinstance(raw_rows, list) else []
        if not rows:
            return ""
        remaining_chars = self.context_max_tokens * 4
        blocks: list[str] = []
        for rank, row in enumerate(rows, start=1):
            snippet = row.get("snippet")
            if not isinstance(snippet, str) or not snippet.strip():
                continue
            title = str(row.get("title") or "Conversation memory")
            block = f"### Argon evidence {rank} · {title}\n{snippet.strip()}"
            if len(block) > remaining_chars:
                if remaining_chars >= 200:
                    blocks.append(block[:remaining_chars].rstrip() + "\n…")
                break
            blocks.append(block)
            remaining_chars -= len(block)
        return "\n\n".join(blocks)

    def close(self) -> None:
        with self._lock:
            process = self._process
            self._process = None
            self._url = self.external_url
            self._clients = threading.local()
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if self._log_handle is not None:
                self._log_handle.close()
                self._log_handle = None
