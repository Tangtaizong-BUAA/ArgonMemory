#!/usr/bin/env python3
"""Render a vendor-style OmniMemEval comparison matrix as deterministic SVG."""

from __future__ import annotations

import argparse
from copy import deepcopy
import html
import json
from pathlib import Path
from typing import Any


ARGON = "Argon Memory"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"Expected a JSON object: {path}")
    return value


def merge_argon(reference: dict[str, Any], result_path: Path | None) -> dict[str, Any]:
    merged = deepcopy(reference)
    if result_path is None:
        return merged
    result = load_json(result_path)
    scores = result.get("scores")
    require(isinstance(scores, dict), "Argon result must contain a scores object")
    known_ids: set[str] = set()
    for group in merged.get("groups", []):
        for row in group.get("rows", []):
            row_id = row.get("id")
            if not isinstance(row_id, str):
                continue
            known_ids.add(row_id)
            if row_id in scores:
                score = scores[row_id]
                require(isinstance(score, (int, float)), f"Argon score {row_id} must be numeric")
                require(0 <= float(score) <= 100, f"Argon score {row_id} is outside 0..100")
                row["values"][ARGON] = float(score)
    unknown = sorted(set(scores) - known_ids)
    require(not unknown, f"Unknown Argon score ids: {', '.join(unknown)}")
    merged["argon_run"] = result.get("run")
    return merged


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def multiline_text(x: float, y: float, lines: list[str], *, size: int, weight: int = 600,
                   fill: str = "#101828", anchor: str = "middle", line_height: int = 25) -> str:
    spans = []
    for index, line in enumerate(lines):
        dy = 0 if index == 0 else line_height
        spans.append(f'<tspan x="{x:.1f}" dy="{dy}">{esc(line)}</tspan>')
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" fill="{fill}" '
        f'font-size="{size}" font-weight="{weight}">' + "".join(spans) + "</text>"
    )


def header_lines(name: str) -> list[str]:
    if name == "Argon Memory":
        return ["Argon", "Memory"]
    if name == "Zep / Graphiti":
        return ["Zep /", "Graphiti"]
    return [name]


def render(data: dict[str, Any], output: Path, *, allow_pending: bool) -> None:
    systems = data.get("systems")
    groups = data.get("groups")
    require(isinstance(systems, list) and systems and systems[0] == ARGON, "Argon Memory must be first")
    require(isinstance(groups, list) and groups, "No benchmark groups found")
    pending = [row["id"] for group in groups for row in group["rows"] if row["values"].get(ARGON) is None]
    require(allow_pending or not pending, f"Argon results are missing: {', '.join(pending)}")

    width = 1560
    margin = 24
    label_width = 348
    column_width = (width - 2 * margin - label_width) / len(systems)
    header_height = 146
    group_height = 64
    row_height = 122
    footer_height = 116
    content_height = header_height + sum(group_height + row_height * len(g["rows"]) for g in groups)
    height = 2 * margin + content_height + footer_height
    argon_x = margin + label_width

    source = data.get("source", {})
    elements: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        '<title id="title">Argon Memory public benchmark comparison</title>',
        '<desc id="desc">OmniMemEval same-protocol reproduced results. Higher is better. Argon Memory is highlighted; missing completed runs are shown as dashes.</desc>',
        '<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="8" stdDeviation="18" flood-color="#101828" flood-opacity="0.08"/></filter></defs>',
        '<rect width="100%" height="100%" fill="#f8faff"/>',
        f'<rect x="{margin}" y="{margin}" width="{width - 2 * margin}" height="{content_height + footer_height}" rx="18" fill="#ffffff" stroke="#e6e9f0" filter="url(#shadow)"/>',
        f'<rect x="{argon_x:.1f}" y="{margin + 1}" width="{column_width:.1f}" height="{content_height - 1}" fill="#eff1ff"/>',
        f'<line x1="{argon_x:.1f}" y1="{margin + header_height}" x2="{argon_x + column_width:.1f}" y2="{margin + header_height}" stroke="#2446ff" stroke-width="3"/>',
        '<g font-family="Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">',
    ]

    header_y = margin
    elements.append(multiline_text(margin + 26, header_y + 50, ["Public memory", "benchmark"], size=22, weight=700, fill="#101828", anchor="start", line_height=28))
    elements.append(multiline_text(margin + 26, header_y + 112, ["OmniMemEval · same protocol"], size=15, weight=500, fill="#667085", anchor="start"))
    for index, system in enumerate(systems):
        x0 = margin + label_width + index * column_width
        center = x0 + column_width / 2
        if index:
            elements.append(f'<line x1="{x0:.1f}" y1="{margin}" x2="{x0:.1f}" y2="{margin + content_height}" stroke="#e9ebf0"/>')
        lines = header_lines(str(system))
        y = header_y + 64 - (len(lines) - 1) * 13
        color = "#173cff" if system == ARGON else "#243bdf"
        elements.append(multiline_text(center, y, lines, size=22, weight=750, fill=color, line_height=26))
        if system == ARGON:
            elements.append(multiline_text(center, header_y + 124, ["this system"], size=13, weight=650, fill="#5b6cff"))

    y = margin + header_height
    for group in groups:
        elements.extend([
            f'<rect x="{margin + 1}" y="{y:.1f}" width="{width - 2 * margin - 2}" height="{group_height}" fill="#dfe4ff"/>',
            f'<line x1="{margin}" y1="{y:.1f}" x2="{width - margin}" y2="{y:.1f}" stroke="#6f84ff" stroke-width="1.4"/>',
            f'<line x1="{margin}" y1="{y + group_height:.1f}" x2="{width - margin}" y2="{y + group_height:.1f}" stroke="#a8b4ff"/>',
            f'<text x="{margin + 26}" y="{y + 41:.1f}" fill="#173cff" font-size="20" font-weight="750">{esc(group["title"])}</text>',
        ])
        y += group_height
        for row in group["rows"]:
            elements.append(f'<line x1="{margin}" y1="{y + row_height:.1f}" x2="{width - margin}" y2="{y + row_height:.1f}" stroke="#e6e8ed"/>')
            elements.append(f'<text x="{margin + 38}" y="{y + 47:.1f}" fill="#17191f" font-size="21" font-weight="720">{esc(row["label"])}</text>')
            elements.append(f'<text x="{margin + 38}" y="{y + 80:.1f}" fill="#667085" font-size="15" font-weight="500">{esc(row["benchmark"])}</text>')
            numeric = [float(v) for v in row["values"].values() if isinstance(v, (int, float))]
            best = max(numeric) if numeric else None
            for index, system in enumerate(systems):
                center = margin + label_width + (index + 0.5) * column_width
                value = row["values"].get(system)
                if isinstance(value, (int, float)):
                    is_best = best is not None and abs(float(value) - best) < 1e-9
                    value_text = f"{float(value):.2f}"
                    weight = 780 if is_best or system == ARGON else 520
                    fill = "#101828" if is_best or system == ARGON else "#4b5568"
                else:
                    value_text = "—"
                    weight = 520
                    fill = "#98a2b3"
                elements.append(f'<text x="{center:.1f}" y="{y + 70:.1f}" text-anchor="middle" fill="{fill}" font-size="23" font-weight="{weight}">{value_text}</text>')
            y += row_height

    footer_y = margin + content_height
    commit = str(source.get("repository_commit", ""))[:8]
    elements.extend([
        f'<text x="{margin + 26}" y="{footer_y + 39}" fill="#475467" font-size="14" font-weight="650">Higher is better · bold = best reproduced score in the public matrix · — = no completed comparable run</text>',
        f'<text x="{margin + 26}" y="{footer_y + 70}" fill="#667085" font-size="13">Answer: {esc(source.get("answer_model", ""))} · Judge: {esc(source.get("judge_model", ""))} · OmniMemEval {esc(commit)}</text>',
        f'<text x="{margin + 26}" y="{footer_y + 94}" fill="#98a2b3" font-size="12">Source: {esc(source.get("url", ""))}</text>',
        '</g></svg>',
    ])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(elements) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", default=str(Path(__file__).with_name("reference-results.json")))
    parser.add_argument("--argon-results")
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-pending", action="store_true")
    args = parser.parse_args()
    data = merge_argon(load_json(Path(args.reference)), Path(args.argon_results) if args.argon_results else None)
    render(data, Path(args.output), allow_pending=args.allow_pending)


if __name__ == "__main__":
    main()
