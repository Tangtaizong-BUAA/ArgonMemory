#!/usr/bin/env python3
"""Dependency-light adapter smoke test; this is not a benchmark score."""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
from typing import Any


def load_adapter(adapter_path: Path) -> type[Any]:
    package = types.ModuleType("memory_modules")
    package.__path__ = []  # type: ignore[attr-defined]
    memory = types.ModuleType("memory_modules.memory")

    class Memory:
        memory_type = ""

        def __init__(self, memory_params: dict[str, object]) -> None:
            self.memory_params = dict(memory_params)

    def register_memory(cls: type[Any]) -> type[Any]:
        return cls

    def require(condition: bool, message: str) -> None:
        if not condition:
            raise RuntimeError(message)

    memory.Memory = Memory
    memory.MemoryConfig = dict
    memory.MemoryContextItem = dict
    memory.register_memory = register_memory
    memory.require = require
    sys.modules["memory_modules"] = package
    sys.modules["memory_modules.memory"] = memory
    spec = importlib.util.spec_from_file_location("memory_modules.argon_memory", adapter_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load Argon Memory benchmark adapter")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.ArgonMemory


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--argon-repo", default=str(Path(__file__).resolve().parents[2]))
    args = parser.parse_args()
    argon_repo = Path(args.argon_repo).expanduser().resolve()
    cli = argon_repo / "dist" / "cli.js"
    if not cli.is_file():
        raise RuntimeError(f"Build Argon Memory first; missing {cli}")
    adapter = load_adapter(Path(__file__).with_name("argon_memory.py"))
    trajectory = {
        "id": "public-smoke-trajectory-001",
        "domain": "enterprise",
        "environment": "synthetic-smoke-only",
        "goal": "Configure the obsidian launch switch",
        "outcome": "success",
        "start_url": "https://benchmark.invalid/start",
        "states": [
            {
                "state_index": 0,
                "step": 0,
                "url": "https://benchmark.invalid/start",
                "action": None,
                "thought": "Inspect the configuration panel.",
                "accessibility_tree": "The obsidian launch switch requires authorization code VELA-73.",
                "screenshot": "missing-for-text-only-smoke.png",
            },
            {
                "state_index": 1,
                "step": 1,
                "url": "https://benchmark.invalid/complete",
                "action": "submit_code('VELA-73')",
                "thought": "Apply the observed authorization code.",
                "accessibility_tree": "Configuration saved successfully.",
                "screenshot": "missing-for-text-only-smoke.png",
            },
        ],
    }
    with tempfile.TemporaryDirectory(prefix="argon-lme-adapter-smoke-") as temp:
        root = Path(temp)
        params = {
            "argon_cli": str(cli),
            "workspace_dir": str(root / "live"),
            "project_id": "project:longmemeval-v2-smoke",
            "search_top_k": 3,
            "context_max_tokens": 2000,
            "max_images": 0,
        }
        memory = adapter(params)
        memory.insert(trajectory)
        first_context = memory.query("What authorization code does the obsidian launch switch require?")
        first_text = "\n".join(item["value"] for item in first_context if item["type"] == "text")
        if "VELA-73" not in first_text:
            raise RuntimeError("Fresh Argon Memory query did not retrieve the expected evidence")
        saved = root / "saved"
        saved.mkdir()
        memory._save_backend(saved)

        reloaded = adapter({**params, "workspace_dir": str(root / "reloaded")})
        reloaded._load_backend(saved)
        second_context = reloaded.query("What authorization code does the obsidian launch switch require?")
        second_text = "\n".join(item["value"] for item in second_context if item["type"] == "text")
        if "VELA-73" not in second_text:
            raise RuntimeError("Reloaded Argon Memory query did not retrieve the expected evidence")
        trace = reloaded.post_query_hook(query="", query_image=None, memory_context=second_context)
        reloaded._stop_server()
        print(
            {
                "status": "pass",
                "fresh_retrieval": True,
                "persisted_retrieval": True,
                "trace": trace,
            }
        )


if __name__ == "__main__":
    main()
