#!/usr/bin/env python3
"""Run Argon Memory with the official LongMemEval-V2 evaluation harness."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--longmemeval-repo", required=True)
    parser.add_argument("--argon-repo", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--domain", choices=["web", "enterprise"], required=True)
    parser.add_argument("--tier", choices=["small", "medium"], default="small")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--reader-model", default=os.getenv("READER_MODEL", "Qwen/Qwen3.5-9B"))
    parser.add_argument("--reader-base-url", default=os.getenv("READER_BASE_URL", "http://localhost:8023/v1"))
    parser.add_argument("--reader-api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--evaluator-model", default=os.getenv("EVALUATOR_MODEL", "gpt-5.2"))
    parser.add_argument("--evaluator-base-url", default=os.getenv("EVALUATOR_BASE_URL"))
    parser.add_argument("--evaluator-api-key-env", default=os.getenv("EVALUATOR_API_KEY_ENV", "OPENAI_API_KEY"))
    parser.add_argument("--memory-context-max-tokens", type=int, default=12000)
    parser.add_argument("--reader-max-concurrent-requests", type=int, default=16)
    parser.add_argument("--index-only", action="store_true")
    args = parser.parse_args()

    lme_repo = Path(args.longmemeval_repo).expanduser().resolve()
    argon_repo = Path(args.argon_repo).expanduser().resolve()
    data_root = Path(args.data_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    require((lme_repo / "evaluation" / "harness.py").is_file(), "Invalid LongMemEval-V2 checkout")
    require((data_root / "questions.jsonl").is_file(), "LongMemEval-V2 data is not downloaded")
    require((data_root / "trajectories.jsonl").is_file(), "LongMemEval-V2 trajectories are missing")
    require(args.limit is None or args.limit > 0, "--limit must be positive")

    installer = Path(__file__).resolve().parent / "install_adapter.py"
    config_path = output_dir / "runtime_inputs" / "argon_memory_config.json"
    subprocess.run(
        [
            sys.executable,
            str(installer),
            "--longmemeval-repo",
            str(lme_repo),
            "--argon-repo",
            str(argon_repo),
            "--data-root",
            str(data_root),
            "--output-config",
            str(config_path),
        ],
        check=True,
    )

    sys.path.insert(0, str(lme_repo))
    from data.public_data import materialize_runtime_haystack, materialize_runtime_questions

    runtime_dir = output_dir / "runtime_inputs"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    questions = materialize_runtime_questions(
        data_root=data_root,
        domain=args.domain,
        question_ids=None,
        limit=args.limit,
        output_path=runtime_dir / "questions.json",
    )
    materialize_runtime_haystack(
        data_root=data_root,
        tier=args.tier,
        selected_questions=questions,
        output_path=runtime_dir / "haystack.json",
    )

    command = [
        sys.executable,
        "-m",
        "evaluation.harness",
        "--domain",
        args.domain,
        "--questions-path",
        str(runtime_dir / "questions.json"),
        "--haystack-path",
        str(runtime_dir / "haystack.json"),
        "--trajectories-path",
        str(data_root / "trajectories.jsonl"),
        "--memory-config-path",
        str(config_path),
        "--output-dir",
        str(output_dir),
        "--prompt-build-max-workers",
        "1",
        "--memory-context-max-tokens",
        str(args.memory_context_max_tokens),
        "--reader-max-concurrent-requests",
        str(args.reader_max_concurrent_requests),
    ]
    if args.index_only:
        command.extend(["--save-memory", "--skip-evaluation"])
    else:
        command.extend(
            [
                "--model",
                args.reader_model,
                "--base-url",
                args.reader_base_url,
                "--api-key-env",
                args.reader_api_key_env,
                "--evaluator-model",
                args.evaluator_model,
                "--evaluator-api-key-env",
                args.evaluator_api_key_env,
            ]
        )
        if args.evaluator_base_url:
            command.extend(["--evaluator-base-url", args.evaluator_base_url])
    print(json.dumps({"command": command, "cwd": str(lme_repo)}, indent=2), flush=True)
    subprocess.run(command, cwd=lme_repo, check=True)


if __name__ == "__main__":
    main()
