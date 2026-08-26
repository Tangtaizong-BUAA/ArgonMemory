#!/usr/bin/env python3
"""
Extract Markdown and addressable content from a MinerU-supported document using
the MinerU cloud SDK (mineru-open-sdk).

Usage:
    MINERU_API_KEY=... extract_pdf_mineru.py <filepath>

Output (stdout, JSON):
    { "pages": [{"page_idx": N, "text": "...", "tokens": N}], "bookmarks": [] }

On error:
    { "error": "message" }
"""
import sys
import json
import os
from collections import defaultdict


def extract_text_from_item(item: dict) -> str:
    """Extract text from a single MinerU content_list item."""
    text = item.get("text", "")
    if text:
        return text.strip()
    table_body = item.get("table_body", "")
    if table_body:
        return table_body.strip()
    code_body = item.get("code_body", "")
    if code_body:
        return code_body.strip()
    list_items = item.get("list_items", [])
    if list_items:
        return "\n".join(list_items).strip()
    return ""


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: MINERU_API_KEY=... extract_pdf_mineru.py <filepath>"}))
        sys.exit(1)

    filepath = sys.argv[1]
    api_key = os.environ.get("MINERU_API_KEY")
    if not api_key:
        print(json.dumps({"error": "MINERU_API_KEY is not configured"}))
        sys.exit(1)

    try:
        from mineru import MinerU
    except ImportError:
        print(json.dumps({"error": "mineru-open-sdk is unavailable or shadowed by a different mineru package. Install it with: pip install mineru-open-sdk"}))
        sys.exit(1)

    try:
        client = MinerU(token=api_key)
        result = client.extract(
            filepath,
            model="vlm",
            timeout=600,
        )
        content_list = result.content_list or []
        markdown = result.markdown or ""
    except Exception as e:
        print(json.dumps({"error": f"MinerU extraction failed: {e}"}))
        sys.exit(1)

    # Group items by page_idx
    by_page: dict = defaultdict(list)
    for item in content_list:
        page_idx = item.get("page_idx", 0)
        by_page[page_idx].append(item)

    pages = []
    for page_idx in sorted(by_page.keys()):
        items = by_page[page_idx]
        texts = [t for t in (extract_text_from_item(i) for i in items) if t]
        page_text = "\n".join(texts)
        pages.append({
            "page_idx": page_idx,
            "text": page_text,
            "tokens": len(page_text) // 4,
        })

    print(json.dumps({
        "source": "mineru",
        "pages": pages,
        "bookmarks": [],
        "markdown": markdown,
    }))


if __name__ == "__main__":
    main()
