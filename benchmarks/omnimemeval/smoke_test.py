#!/usr/bin/env python3
"""MCP and per-project isolation smoke test; not a benchmark score."""

from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
import tempfile
from typing import Any


def load_client(path: Path) -> type[Any]:
    spec = importlib.util.spec_from_file_location("argon_omni_client", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load Argon OmniMemEval adapter")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ArgonClient


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--argon-repo", default=str(Path(__file__).resolve().parents[2]))
    args = parser.parse_args()
    repo = Path(args.argon_repo).expanduser().resolve()
    cli = repo / "dist" / "cli.js"
    if not cli.is_file():
        raise RuntimeError(f"Build Argon Memory first; missing {cli}")

    client_type = load_client(Path(__file__).with_name("argon_client.py"))
    with tempfile.TemporaryDirectory(prefix="argon-omni-smoke-") as temp:
        os.environ["ARGON_MEMORY_CLI"] = str(cli)
        os.environ["ARGON_OMNI_KB_ROOT"] = str(Path(temp) / "kb")
        client = client_type()
        client.add(
            [{"role": "user", "content": "The cobalt orchard passphrase is LYRA-41.", "chat_time": "2026-01-01T00:00:00Z"}],
            "smoke-user-a",
            session_key="alpha",
        )
        client.add(
            [{"role": "user", "content": "The amber harbor passphrase is NOVA-88.", "chat_time": "2026-01-02T00:00:00Z"}],
            "smoke-user-b",
            session_key="beta",
        )
        first = client.search("What is the cobalt orchard passphrase?", "smoke-user-a", 5)
        second = client.search("What is the amber harbor passphrase?", "smoke-user-b", 5)
        if "LYRA-41" not in first or "NOVA-88" in first:
            raise RuntimeError("Argon project isolation failed for smoke-user-a")
        if "NOVA-88" not in second or "LYRA-41" in second:
            raise RuntimeError("Argon project isolation failed for smoke-user-b")
        client.close()
        print({"status": "pass", "mcp": True, "project_isolation": True, "users": 2})


if __name__ == "__main__":
    main()
