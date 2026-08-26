#!/usr/bin/env python3
"""Run a retrieval-only diagnostic over public LongMemEval-V2 questions.

This is not an official answer-accuracy score. Gold answers are inspected only
after ``memory.query`` completes, and only to report literal evidence coverage
for deterministic phrase-set items.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import statistics
import sys
import unicodedata


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((len(ordered) - 1) * fraction)))
    return round(ordered[index], 3)


def normalize_for_coverage(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE).strip()


def literal_phrase_coverage(eval_function: str, answer: str, context: str) -> dict[str, object] | None:
    if not eval_function.startswith("norm_phrase_set_match"):
        return None
    phrases = [part.strip() for part in re.split(r"[;,]", answer) if part.strip()]
    if not phrases:
        return None
    normalized_context = normalize_for_coverage(context)
    covered = [phrase for phrase in phrases if normalize_for_coverage(phrase) in normalized_context]
    return {
        "phrase_count": len(phrases),
        "covered_phrase_count": len(covered),
        "all_phrases_present": len(covered) == len(phrases),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--longmemeval-repo", required=True)
    parser.add_argument("--memory-state", required=True)
    parser.add_argument("--questions-path", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    lme_repo = Path(args.longmemeval_repo).expanduser().resolve()
    memory_state = Path(args.memory_state).expanduser().resolve()
    questions_path = Path(args.questions_path).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    require((lme_repo / "memory_modules" / "memory.py").is_file(), "Invalid LongMemEval-V2 checkout")
    require((memory_state / "memory_config.json").is_file(), "Invalid saved memory state")
    require(questions_path.is_file(), "Questions file does not exist")
    require(args.limit is None or args.limit > 0, "--limit must be positive")

    sys.path.insert(0, str(lme_repo))
    from evaluation.harness import get_question_components
    from memory_modules.memory import load_memory

    questions = json.loads(questions_path.read_text(encoding="utf-8"))
    require(isinstance(questions, list), "Questions file must contain a JSON list")
    if args.limit is not None:
        questions = questions[: args.limit]
    memory = load_memory(memory_state)
    results: list[dict[str, object]] = []
    for item in questions:
        require(isinstance(item, dict), "Question item must be an object")
        question_text, question_image = get_question_components(item.get("question"))
        context_items = memory.query(question_text, question_image)
        trace = memory.post_query_hook(
            query=question_text,
            query_image=question_image,
            memory_context=context_items,
        ) or {}
        text_context = "\n\n".join(
            context_item["value"]
            for context_item in context_items
            if context_item.get("type") == "text"
        )
        coverage = literal_phrase_coverage(
            str(item.get("eval_function", "")),
            str(item.get("answer", "")),
            text_context,
        )
        results.append(
            {
                "question_id": item.get("id"),
                "question_type": item.get("question_type"),
                "eval_function": item.get("eval_function"),
                "memory_context_nonempty": bool(context_items),
                "retrieved_record_ids": trace.get("retrieved_record_ids", []),
                "query_latency_ms": trace.get("query_latency_ms"),
                "estimated_context_tokens": trace.get("estimated_context_tokens"),
                "returned_images": trace.get("returned_images"),
                "literal_gold_evidence_coverage": coverage,
            }
        )

    latencies = [
        float(row["query_latency_ms"])
        for row in results
        if isinstance(row.get("query_latency_ms"), (int, float))
    ]
    token_counts = [
        int(row["estimated_context_tokens"])
        for row in results
        if isinstance(row.get("estimated_context_tokens"), int)
    ]
    applicable = [
        row["literal_gold_evidence_coverage"]
        for row in results
        if isinstance(row.get("literal_gold_evidence_coverage"), dict)
    ]
    full_coverage = sum(bool(row.get("all_phrases_present")) for row in applicable)
    report = {
        "claim_level": "public_retrieval_diagnostic_not_official_accuracy",
        "question_count": len(results),
        "nonempty_context_count": sum(bool(row["memory_context_nonempty"]) for row in results),
        "query_latency_ms": {
            "mean": round(statistics.fmean(latencies), 3) if latencies else None,
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
        },
        "estimated_context_tokens": {
            "mean": round(statistics.fmean(token_counts), 3) if token_counts else None,
            "p50": percentile([float(value) for value in token_counts], 0.50),
            "p95": percentile([float(value) for value in token_counts], 0.95),
        },
        "literal_phrase_evidence_coverage": {
            "applicable_question_count": len(applicable),
            "all_phrases_present_count": full_coverage,
            "rate": round(full_coverage / len(applicable), 6) if applicable else None,
            "note": "Gold is checked only after retrieval and is never passed to memory.query.",
        },
        "results": results,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "results"}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
