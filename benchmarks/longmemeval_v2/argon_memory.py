"""LongMemEval-V2 backend for Argon Memory.

This module is copied into the official LongMemEval-V2 ``memory_modules``
package by ``install_adapter.py``.  It deliberately talks to Argon Memory
through the public Streamable HTTP MCP endpoint instead of importing private
runtime classes, so the benchmark exercises the same boundary used by agents.
"""

from __future__ import annotations

import atexit
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .memory import Memory, MemoryConfig, MemoryContextItem, register_memory, require


MCP_PROTOCOL_VERSION = "2025-06-18"
ADAPTER_VERSION = "0.1.0"
INLINE_UPLOAD_LIMIT = 6 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024
SECRET_PATTERN = re.compile(
    r"(?:gh[ops]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)"
)
IMAGE_LINK_PATTERN = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def _require_string(value: object, name: str) -> str:
    require(isinstance(value, str) and value.strip(), f"{name} must be a non-empty string")
    return value.strip()


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")
    return (cleaned or "trajectory")[:120]


def _redact_credential_like_text(value: str) -> tuple[str, int]:
    matches = 0

    def replace(_match: re.Match[str]) -> str:
        nonlocal matches
        matches += 1
        return "[CREDENTIAL-LIKE-TEXT-REDACTED]"

    return SECRET_PATTERN.sub(replace, value), matches


class _McpClient:
    def __init__(self, url: str, bearer_token: str | None = None) -> None:
        self.url = url
        self.bearer_token = bearer_token
        self.session_id: str | None = None
        self._next_id = 1
        self._lock = threading.RLock()
        self._initialize()

    def _decode_response(self, raw: bytes, content_type: str) -> dict[str, Any] | None:
        if not raw.strip():
            return None
        text = raw.decode("utf-8")
        if "text/event-stream" in content_type:
            data_lines = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
            require(data_lines, "MCP server returned an empty event stream")
            text = data_lines[-1]
        payload = json.loads(text)
        require(isinstance(payload, dict), "MCP response must be a JSON object")
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
            headers = {
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            }
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
                    session_id = response.headers.get("Mcp-Session-Id")
                    if session_id:
                        self.session_id = session_id
                    decoded = self._decode_response(
                        response.read(),
                        response.headers.get("Content-Type", "application/json"),
                    )
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"MCP HTTP {exc.code}: {detail[:1000]}") from exc
            except URLError as exc:
                raise RuntimeError(f"Could not reach Argon Memory MCP at {self.url}: {exc}") from exc
            if decoded and "error" in decoded:
                raise RuntimeError(f"MCP JSON-RPC error: {decoded['error']}")
            return decoded

    def _initialize(self) -> None:
        response = self._request(
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "argon-longmemeval-v2", "version": ADAPTER_VERSION},
            },
        )
        require(response is not None and isinstance(response.get("result"), dict), "MCP initialize failed")
        self._request("notifications/initialized", {}, notification=True)

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = self._request("tools/call", {"name": name, "arguments": arguments})
        require(response is not None and isinstance(response.get("result"), dict), f"Missing MCP result for {name}")
        result = response["result"]
        if result.get("isError"):
            content = result.get("content")
            raise RuntimeError(f"Argon Memory tool {name} failed: {content}")
        structured = result.get("structuredContent")
        return structured if isinstance(structured, dict) else result


@register_memory
class ArgonMemory(Memory):
    """Official LongMemEval-V2 adapter using Argon Memory's MCP surface."""

    memory_type = "argon_memory"

    def __init__(self, memory_params: dict[str, object]) -> None:
        super().__init__(memory_params)
        allowed = {
            "argon_cli",
            "workspace_dir",
            "trajectories_root_dir",
            "mcp_url",
            "bearer_token_env",
            "project_id",
            "search_top_k",
            "context_max_tokens",
            "max_images",
        }
        unexpected = sorted(set(memory_params) - allowed)
        require(not unexpected, f"argon_memory received unexpected parameters: {unexpected}")

        configured_workspace = memory_params.get("workspace_dir")
        if isinstance(configured_workspace, str) and configured_workspace.strip():
            self.workspace_dir = Path(configured_workspace).expanduser().resolve()
            self.workspace_dir.mkdir(parents=True, exist_ok=True)
        else:
            self.workspace_dir = Path(tempfile.mkdtemp(prefix="argon-lme-v2-"))
        self.kb_root = self.workspace_dir / "argon-kb"
        self.trajectories_root_dir = (
            Path(str(memory_params["trajectories_root_dir"])).expanduser().resolve()
            if isinstance(memory_params.get("trajectories_root_dir"), str)
            and str(memory_params.get("trajectories_root_dir")).strip()
            else None
        )
        self.argon_cli = (
            Path(str(memory_params["argon_cli"])).expanduser().resolve()
            if isinstance(memory_params.get("argon_cli"), str)
            and str(memory_params.get("argon_cli")).strip()
            else None
        )
        self.external_mcp_url = (
            str(memory_params["mcp_url"]).strip()
            if isinstance(memory_params.get("mcp_url"), str)
            and str(memory_params.get("mcp_url")).strip()
            else None
        )
        self.bearer_token_env = str(memory_params.get("bearer_token_env", "ARGON_MEMORY_TOKEN"))
        self.project_id = str(memory_params.get("project_id", "project:longmemeval-v2"))
        require(self.project_id.startswith("project:"), "argon_memory project_id must start with project:")
        self.search_top_k = max(1, min(int(memory_params.get("search_top_k", 6)), 20))
        self.context_max_tokens = max(400, min(int(memory_params.get("context_max_tokens", 12000)), 40000))
        self.max_images = max(0, min(int(memory_params.get("max_images", 3)), 12))

        self._process: subprocess.Popen[str] | None = None
        self._server_log_handle: Any | None = None
        self._mcp_url: str | None = None
        self._clients = threading.local()
        self._lifecycle_lock = threading.RLock()
        self._work_id: str | None = None
        self._inserted_ids: set[str] = set()
        self._artifact_ids: dict[str, str] = {}
        self._redaction_count = 0
        self._insert_latencies_ms: list[float] = []
        self._query_trace = threading.local()
        atexit.register(self._stop_server)

    @classmethod
    def reconcile_loaded_memory_config(
        cls,
        saved_config: MemoryConfig,
        requested_config: MemoryConfig | None,
    ) -> MemoryConfig:
        require(saved_config["memory_type"] == cls.memory_type, "Saved memory type is not argon_memory")
        if requested_config is None:
            return saved_config
        require(requested_config["memory_type"] == cls.memory_type, "Requested memory type is not argon_memory")
        saved = dict(saved_config["memory_params"])
        requested = dict(requested_config["memory_params"])
        # Runtime locations may legitimately change when a saved benchmark is moved.
        for key in ("workspace_dir", "mcp_url", "argon_cli", "trajectories_root_dir"):
            saved.pop(key, None)
            requested.pop(key, None)
        require(saved == requested, "Loaded Argon Memory query parameters do not match the saved benchmark")
        return requested_config

    def _start_server(self) -> None:
        with self._lifecycle_lock:
            if self._mcp_url:
                return
            if self.external_mcp_url:
                self._mcp_url = self.external_mcp_url
                return
            cli_override = os.getenv("ARGON_MEMORY_CLI")
            cli = Path(cli_override).expanduser().resolve() if cli_override else self.argon_cli
            require(cli is not None and cli.exists(), "argon_memory requires a built Argon Memory dist/cli.js")
            self.kb_root.mkdir(parents=True, exist_ok=True)
            port = _free_loopback_port()
            log_path = self.workspace_dir / "argon-server.log"
            self._server_log_handle = log_path.open("a", encoding="utf-8")
            env = os.environ.copy()
            env.update(
                {
                    "ARGON_MEMORY_HOST": "127.0.0.1",
                    "ARGON_MEMORY_PORT": str(port),
                    "ARGON_MEMORY_KB_ROOT": str(self.kb_root),
                    "ARGON_MEMORY_MCP_PROFILE": "project-ops",
                    "ARGON_MEMORY_ALLOW_UNAUTHENTICATED": "true",
                }
            )
            self._process = subprocess.Popen(
                [os.getenv("NODE_BINARY", "node"), str(cli)],
                env=env,
                stdout=self._server_log_handle,
                stderr=self._server_log_handle,
                text=True,
            )
            health_url = f"http://127.0.0.1:{port}/health"
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if self._process.poll() is not None:
                    raise RuntimeError(f"Argon Memory server exited early; see {log_path}")
                try:
                    with urlopen(health_url, timeout=1) as response:
                        if response.status == 200:
                            self._mcp_url = f"http://127.0.0.1:{port}/mcp"
                            break
                except (URLError, TimeoutError):
                    time.sleep(0.1)
            require(self._mcp_url is not None, f"Timed out starting Argon Memory server; see {log_path}")

    def _stop_server(self) -> None:
        with self._lifecycle_lock:
            process = self._process
            self._process = None
            self._mcp_url = self.external_mcp_url
            self._clients = threading.local()
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if self._server_log_handle is not None:
                self._server_log_handle.close()
                self._server_log_handle = None

    def _client(self) -> _McpClient:
        self._start_server()
        client = getattr(self._clients, "client", None)
        if client is None:
            token = os.getenv(self.bearer_token_env) if self.external_mcp_url else None
            client = _McpClient(_require_string(self._mcp_url, "MCP URL"), token)
            self._clients.client = client
        return client

    def _ensure_project(self) -> None:
        if self._work_id:
            return
        with self._lifecycle_lock:
            if self._work_id:
                return
            client = self._client()
            client.call_tool(
                "kb_bootstrap_project",
                {
                    "project_id": self.project_id,
                    "title": "LongMemEval-V2 Benchmark Memory",
                    "mission": "Persist and retrieve evidence from public long-horizon agent trajectories.",
                },
            )
            started = client.call_tool(
                "kb_start_work",
                {
                    "project_id": self.project_id,
                    "objective": "Index LongMemEval-V2 public trajectories",
                    "expected_outputs": ["searchable trajectory artifacts"],
                    "acceptance_criteria": ["every selected trajectory is durably stored with provenance"],
                    "input_refs": ["benchmark:longmemeval-v2"],
                },
            )
            self._work_id = _require_string(started.get("work_id"), "kb_start_work work_id")

    def _resolve_screenshot(self, value: object) -> Path | None:
        if not isinstance(value, str) or not value.strip():
            return None
        raw = Path(value)
        candidates = [raw] if raw.is_absolute() else []
        if self.trajectories_root_dir is not None and not raw.is_absolute():
            candidates.extend(
                [
                    self.trajectories_root_dir / raw,
                    self.trajectories_root_dir / "screenshots" / raw,
                ]
            )
        for candidate in candidates:
            if candidate.exists() and candidate.is_file():
                return candidate.resolve()
        return None

    def _format_trajectory(self, trajectory: dict[str, object]) -> str:
        trajectory_id = _require_string(trajectory.get("id"), "trajectory id")
        goal = str(trajectory.get("goal") or "<unknown>")
        outcome = str(trajectory.get("outcome") or "<unknown>")
        start_url = str(trajectory.get("start_url") or "<unknown>")
        domain = str(trajectory.get("domain") or "<unknown>")
        environment = str(trajectory.get("environment") or "<unknown>")
        states = trajectory.get("states")
        require(isinstance(states, list) and states, f"trajectory {trajectory_id} has no states")
        lines = [
            f"# Agent trajectory {trajectory_id}",
            "",
            f"- Domain: {domain}",
            f"- Environment: {environment}",
            f"- Goal: {goal}",
            f"- Outcome: {outcome}",
            f"- Start URL: {start_url}",
            "",
            "## Ordered states and actions",
        ]
        for ordinal, raw_state in enumerate(states):
            require(isinstance(raw_state, dict), f"trajectory {trajectory_id} state {ordinal} is not an object")
            state_index = raw_state.get("state_index", ordinal)
            lines.extend(
                [
                    "",
                    f"### State {state_index}",
                    f"- Step: {raw_state.get('step', ordinal)}",
                    f"- URL: {raw_state.get('url') or '<unknown>'}",
                    f"- Thought: {raw_state.get('thought', raw_state.get('thoughts')) or '<none>'}",
                    f"- Action: {raw_state.get('action') or '<none>'}",
                    "",
                    "Accessibility tree:",
                    "```text",
                    str(raw_state.get("accessibility_tree", raw_state.get("text")) or ""),
                    "```",
                ]
            )
            screenshot = self._resolve_screenshot(raw_state.get("screenshot"))
            if screenshot is not None:
                lines.extend(["", f"![State {state_index} screenshot]({screenshot})"])
        markdown, redactions = _redact_credential_like_text("\n".join(lines).strip() + "\n")
        self._redaction_count += redactions
        return markdown

    def _publish_text(self, trajectory_id: str, markdown: str) -> str:
        self._ensure_project()
        payload = markdown.encode("utf-8")
        client = self._client()
        common = {
            "work_id": self._work_id,
            "title": f"LongMemEval-V2 trajectory {trajectory_id}",
            "filename": f"{_safe_filename(trajectory_id)}.md",
            "content_type": "text/markdown",
            "kind": "document",
            "source_refs": ["benchmark:longmemeval-v2", f"trajectory:{trajectory_id}"],
            "confidentiality": "internal",
        }
        if len(payload) <= INLINE_UPLOAD_LIMIT:
            result = client.call_tool(
                "kb_publish_resource",
                {
                    "work_id": self._work_id,
                    "resource": {
                        **{key: value for key, value in common.items() if key != "work_id"},
                        "encoding": "utf8",
                        "content": markdown,
                    },
                },
            )
        else:
            begun = client.call_tool(
                "kb_begin_resource_upload",
                {
                    **common,
                    "expected_size": len(payload),
                    "expected_sha256": hashlib.sha256(payload).hexdigest(),
                },
            )
            upload_id = _require_string(begun.get("upload_id"), "chunked upload id")
            offset = 0
            while offset < len(payload):
                chunk = payload[offset : offset + UPLOAD_CHUNK_BYTES]
                client.call_tool(
                    "kb_append_resource_chunk",
                    {
                        "upload_id": upload_id,
                        "offset": offset,
                        "content_base64": base64.b64encode(chunk).decode("ascii"),
                    },
                )
                offset += len(chunk)
            result = client.call_tool("kb_commit_resource_upload", {"upload_id": upload_id})
        return _require_string(result.get("artifact_id"), "published artifact_id")

    def insert(self, trajectory: dict[str, object]) -> None:
        trajectory_id = _require_string(trajectory.get("id"), "trajectory id")
        require(trajectory_id not in self._inserted_ids, f"Duplicate trajectory insert attempted: {trajectory_id}")
        started = time.perf_counter()
        markdown = self._format_trajectory(trajectory)
        artifact_id = self._publish_text(trajectory_id, markdown)
        self._inserted_ids.add(trajectory_id)
        self._artifact_ids[trajectory_id] = artifact_id
        self._insert_latencies_ms.append((time.perf_counter() - started) * 1000)

    def _images_from_context(self, text: str) -> list[str]:
        images: list[str] = []
        for raw in IMAGE_LINK_PATTERN.findall(text):
            candidate = raw.strip().strip("<>")
            path = Path(candidate)
            if path.exists() and path.is_file():
                resolved = str(path.resolve())
                if resolved not in images:
                    images.append(resolved)
            if len(images) >= self.max_images:
                break
        return images

    def query(self, query: str, query_image: str | None = None) -> list[MemoryContextItem]:
        self._ensure_project()
        started = time.perf_counter()
        searched = self._client().call_tool(
            "kb_search",
            {"query": query, "top_k": self.search_top_k, "include_unverified": False},
        )
        raw_results = searched.get("results")
        rows = [row for row in raw_results if isinstance(row, dict)] if isinstance(raw_results, list) else []
        artifact_rows = [row for row in rows if row.get("type") == "artifact"]
        selected = artifact_rows[: self.search_top_k]
        per_result_tokens = max(200, self.context_max_tokens // max(1, len(selected)))
        evidence_blocks: list[str] = []
        image_paths: list[str] = []
        result_ids: list[str] = []
        for rank, row in enumerate(selected, start=1):
            node_id = row.get("id")
            if not isinstance(node_id, str) or not node_id:
                continue
            graph = self._client().call_tool(
                "kb_graph_context",
                {
                    "node_id": node_id,
                    "query": query,
                    "depth": 0,
                    "artifact_mode": "excerpt",
                    "max_nodes": 1,
                    "max_artifacts": 0,
                    "max_tokens": min(per_result_tokens, 8000),
                },
            )
            focus = graph.get("focus")
            content = focus.get("content") if isinstance(focus, dict) else None
            if not isinstance(content, str) or not content.strip():
                continue
            result_ids.append(node_id)
            evidence_blocks.append(
                "\n".join(
                    [
                        f"### Argon Memory evidence {rank}",
                        f"- Record: {node_id}",
                        f"- Retrieval score: {row.get('score', 0)}",
                        "",
                        content.strip(),
                    ]
                )
            )
            for image in self._images_from_context(content):
                if image not in image_paths and len(image_paths) < self.max_images:
                    image_paths.append(image)
        context = "\n\n".join(evidence_blocks)
        latency_ms = (time.perf_counter() - started) * 1000
        self._query_trace.value = {
            "adapter_version": ADAPTER_VERSION,
            "query_latency_ms": round(latency_ms, 3),
            "retrieved_record_ids": result_ids,
            "retrieved_record_count": len(result_ids),
            "context_chars": len(context),
            "estimated_context_tokens": (len(context) + 3) // 4,
            "returned_images": len(image_paths),
            "query_image_used_for_retrieval": False,
        }
        items: list[MemoryContextItem] = []
        if context:
            items.append({"type": "text", "value": context})
        items.extend({"type": "image", "value": image} for image in image_paths)
        return items

    def post_query_hook(
        self,
        *,
        query: str,
        query_image: str | None,
        memory_context: list[MemoryContextItem],
    ) -> dict[str, object] | None:
        trace = getattr(self._query_trace, "value", None)
        if not isinstance(trace, dict):
            return None
        return {
            **trace,
            "inserted_trajectories": len(self._inserted_ids),
            "credential_like_redactions": self._redaction_count,
            "mean_insert_latency_ms": (
                round(sum(self._insert_latencies_ms) / len(self._insert_latencies_ms), 3)
                if self._insert_latencies_ms
                else None
            ),
        }

    def _save_backend(self, output_dir: Path) -> None:
        self._ensure_project()
        self._stop_server()
        target = output_dir / "argon_kb"
        require(not target.exists(), f"Refusing to overwrite saved Argon Memory state: {target}")
        shutil.copytree(self.kb_root, target)
        state = {
            "adapter_version": ADAPTER_VERSION,
            "project_id": self.project_id,
            "work_id": self._work_id,
            "inserted_trajectory_ids": sorted(self._inserted_ids),
            "artifact_ids": self._artifact_ids,
            "credential_like_redactions": self._redaction_count,
            "insert_latencies_ms": self._insert_latencies_ms,
        }
        (output_dir / "argon_state.json").write_text(
            json.dumps(state, indent=2, ensure_ascii=True) + "\n",
            encoding="utf-8",
        )

    def _load_backend(self, input_dir: Path) -> None:
        self._stop_server()
        saved_root = input_dir / "argon_kb"
        state_path = input_dir / "argon_state.json"
        require(saved_root.is_dir(), f"Missing saved Argon Memory root: {saved_root}")
        require(state_path.is_file(), f"Missing saved Argon Memory state: {state_path}")
        state = json.loads(state_path.read_text(encoding="utf-8"))
        require(isinstance(state, dict), "argon_state.json must contain an object")
        self.kb_root = saved_root.resolve()
        self.project_id = str(state.get("project_id", self.project_id))
        saved_work_id = state.get("work_id")
        self._work_id = saved_work_id if isinstance(saved_work_id, str) and saved_work_id else None
        inserted = state.get("inserted_trajectory_ids", [])
        artifacts = state.get("artifact_ids", {})
        self._inserted_ids = set(item for item in inserted if isinstance(item, str))
        self._artifact_ids = {
            str(key): str(value)
            for key, value in artifacts.items()
            if isinstance(key, str) and isinstance(value, str)
        } if isinstance(artifacts, dict) else {}
        self._redaction_count = int(state.get("credential_like_redactions", 0))
        latencies = state.get("insert_latencies_ms", [])
        self._insert_latencies_ms = [float(item) for item in latencies if isinstance(item, (int, float))]
