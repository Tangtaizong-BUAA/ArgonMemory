#!/usr/bin/env python3
"""Collect validated Argon scores from an OmniMemEval results tree."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Callable


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"Expected JSON object: {path}")
    return value


def number(value: Any, label: str) -> float:
    require(isinstance(value, (int, float)), f"Missing numeric metric: {label}")
    result = float(value)
    require(0 <= result <= 100, f"Metric outside 0..100: {label}={result}")
    return result * 100 if result <= 1 else result


def nested(data: dict[str, Any], *path: str) -> Any:
    value: Any = data
    for key in path:
        require(isinstance(value, dict) and key in value, f"Missing metric path: {'.'.join(path)}")
        value = value[key]
    return value


def validate_pipeline(data: dict[str, Any], source: Path) -> None:
    status = data.get("pipeline_status")
    require(isinstance(status, dict) and status, f"Missing pipeline_status: {source}")
    for stage, stage_status in status.items():
        require(isinstance(stage_status, dict), f"Invalid {stage} status: {source}")
        counts = stage_status.get("status_counts", {})
        if isinstance(counts, dict):
            bad = sum(int(value) for key, value in counts.items() if key not in {"success"} and isinstance(value, (int, float)))
            require(bad == 0, f"Non-success {stage} records in {source}")
        for key, value in stage_status.items():
            if not (key.startswith("failed") or key.startswith("skipped")):
                continue
            amount = len(value) if isinstance(value, list) else int(value or 0) if isinstance(value, (int, float)) else 0
            require(amount == 0, f"{stage}.{key} is non-zero in {source}")


def standard_metrics(data: dict[str, Any]) -> dict[str, float]:
    metrics = nested(data, "metrics")
    output: dict[str, float] = {}
    if isinstance(metrics, dict):
        context = metrics.get("context_tokens")
        if isinstance(context, (int, float)):
            output["context_tokens"] = float(context)
        duration = metrics.get("duration")
        if isinstance(duration, dict):
            for key in ("search_duration_ms", "search_duration_ms_p50", "search_duration_ms_p95", "add_duration_ms"):
                value = duration.get(key)
                if isinstance(value, (int, float)):
                    output[key] = float(value)
    return output


def beam_scale(data: dict[str, Any], target: str) -> dict[str, Any]:
    scales = nested(data, "per_scale")
    require(isinstance(scales, dict), "BEAM per_scale must be an object")
    for key, value in scales.items():
        if str(key).lower().replace("_", "") == target.lower().replace("_", ""):
            require(isinstance(value, dict), f"Invalid BEAM scale: {key}")
            return value
    raise RuntimeError(f"Missing BEAM scale: {target}")


Extractor = Callable[[dict[str, Any]], tuple[float, dict[str, float]]]


def judged(metric_name: str) -> Extractor:
    def extract(data: dict[str, Any]) -> tuple[float, dict[str, float]]:
        return number(nested(data, "metrics", metric_name), metric_name), standard_metrics(data)
    return extract


def persona(data: dict[str, Any]) -> tuple[float, dict[str, float]]:
    score = number(nested(data, "metrics", "accuracy"), "accuracy")
    metrics = nested(data, "metrics")
    output: dict[str, float] = {}
    if isinstance(metrics, dict):
        search = metrics.get("search_duration")
        if isinstance(search, dict):
            for key in ("mean", "p50", "p95"):
                value = search.get(key)
                if isinstance(value, (int, float)):
                    output[f"search_duration_ms_{key}"] = float(value)
    return score, output


def beam(target: str) -> Extractor:
    def extract(data: dict[str, Any]) -> tuple[float, dict[str, float]]:
        scale = beam_scale(data, target)
        score = number(scale.get("nugget_score_mean"), f"BEAM {target}")
        output: dict[str, float] = {}
        duration = scale.get("duration")
        if isinstance(duration, dict):
            for key, value in duration.items():
                if isinstance(value, (int, float)):
                    output[key] = float(value)
        return score, output
    return extract


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--omnimemeval-repo", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--harness-commit", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args()

    repo = Path(args.omnimemeval_repo).expanduser().resolve()
    results = repo / "results"
    version = args.version
    specs: list[tuple[str, Path, Extractor]] = [
        ("locomo", results / "locomo" / f"argon-{version}" / "argon_locomo_grades.json", judged("llm_judge_score")),
        ("longmemeval", results / "lme" / f"argon-{version}" / "argon_lme_grades.json", judged("llm_judge_score")),
        ("beam_100k", results / "beam" / f"argon-{version}" / "argon_beam_grades.json", beam("100K")),
        ("beam_10m", results / "beam" / f"argon-{version}" / "argon_beam_grades.json", beam("10M")),
        ("personamem_v2", results / "pmv2" / f"argon-{version}" / "argon_pm_grades.json", persona),
        ("halumem", results / "halumem" / f"argon-{version}" / "argon_hm_grades.json", judged("llm_judge_score")),
    ]
    scores: dict[str, float] = {}
    efficiency: dict[str, dict[str, float]] = {}
    evidence: dict[str, str] = {}
    for benchmark_id, path, extractor in specs:
        if not path.is_file():
            continue
        data = read_json(path)
        validate_pipeline(data, path)
        score, metrics = extractor(data)
        scores[benchmark_id] = round(score, 4)
        efficiency[benchmark_id] = metrics
        evidence[benchmark_id] = str(path.relative_to(repo))

    expected = {benchmark_id for benchmark_id, _, _ in specs}
    missing = sorted(expected - set(scores))
    require(scores, "No completed Argon OmniMemEval result files were found")
    require(args.allow_partial or not missing, f"Missing completed benchmark results: {', '.join(missing)}")
    output = {
        "run": {
            "system": "Argon Memory",
            "adapter": "public Streamable HTTP MCP",
            "omnimemeval_commit": args.harness_commit,
            "version": version,
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "partial": bool(missing),
            "missing": missing,
            "evidence": evidence,
        },
        "scores": scores,
        "efficiency": efficiency,
    }
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print({"status": "collected", "scores": scores, "missing": missing, "output": str(destination)})


if __name__ == "__main__":
    main()
