#!/usr/bin/env python3
"""Install the Argon Memory backend into an official LongMemEval-V2 checkout."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil


IMPORT_LINE = "from .argon_memory import ArgonMemory  # noqa: E402,F401"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--longmemeval-repo", required=True)
    parser.add_argument("--argon-repo", required=True)
    parser.add_argument("--data-root", default=None)
    parser.add_argument("--output-config", default=None)
    args = parser.parse_args()

    adapter_dir = Path(__file__).resolve().parent
    lme_repo = Path(args.longmemeval_repo).expanduser().resolve()
    argon_repo = Path(args.argon_repo).expanduser().resolve()
    memory_module = lme_repo / "memory_modules" / "memory.py"
    target_adapter = lme_repo / "memory_modules" / "argon_memory.py"
    argon_cli = argon_repo / "dist" / "cli.js"
    require(memory_module.is_file(), f"Not an official LongMemEval-V2 checkout: {lme_repo}")
    require((lme_repo / "LICENSE").is_file(), "LongMemEval-V2 LICENSE is missing")
    require(argon_cli.is_file(), f"Build Argon Memory first; missing {argon_cli}")

    shutil.copy2(adapter_dir / "argon_memory.py", target_adapter)
    memory_text = memory_module.read_text(encoding="utf-8")
    if IMPORT_LINE not in memory_text:
        memory_module.write_text(memory_text.rstrip() + f"\n{IMPORT_LINE}\n", encoding="utf-8")

    output_config = (
        Path(args.output_config).expanduser().resolve()
        if args.output_config
        else lme_repo / "argon_memory_config.json"
    )
    config = {
        "memory_type": "argon_memory",
        "memory_params": {
            "argon_cli": str(argon_cli),
            "trajectories_root_dir": str(Path(args.data_root).expanduser().resolve()) if args.data_root else None,
            "project_id": "project:longmemeval-v2",
            "search_top_k": 6,
            "context_max_tokens": 12000,
            "max_images": 3,
        },
    }
    output_config.parent.mkdir(parents=True, exist_ok=True)
    output_config.write_text(json.dumps(config, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": "installed",
                "adapter": str(target_adapter),
                "registry": str(memory_module),
                "config": str(output_config),
                "argon_cli": str(argon_cli),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
