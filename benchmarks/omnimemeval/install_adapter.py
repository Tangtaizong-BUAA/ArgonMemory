#!/usr/bin/env python3
"""Install the Argon backend into a pinned OmniMemEval checkout."""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil


REGISTRY_ENTRY = '    "argon":       ("argon_client",       "ArgonClient"),'
DISPATCH_ENTRY = '    "argon": generic_text_search,'
LOCOMO_DISPATCH_ENTRY = '        "argon": generic_text_search,'


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def insert_before(text: str, marker: str, line: str) -> str:
    if line in text:
        return text
    index = text.find(marker)
    require(index >= 0, f"Could not find patch marker: {marker!r}")
    return text[:index] + line + "\n" + text[index:]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--omnimemeval-repo", required=True)
    args = parser.parse_args()

    source_dir = Path(__file__).resolve().parent
    repo = Path(args.omnimemeval_repo).expanduser().resolve()
    factory_dir = repo / "scripts" / "client_factory"
    registry = factory_dir / "registry.py"
    search_helpers = repo / "scripts" / "utils" / "search_helpers.py"
    locomo_search = repo / "scripts" / "locomo" / "locomo_search.py"
    require(
        registry.is_file() and search_helpers.is_file() and locomo_search.is_file(),
        f"Not an OmniMemEval checkout: {repo}",
    )
    require((repo / "LICENSE").is_file(), "OmniMemEval LICENSE is missing")

    shutil.copy2(source_dir / "argon_client.py", factory_dir / "argon_client.py")
    registry_text = insert_before(registry.read_text(encoding="utf-8"), "}\n\nSUPPORTED_LIBS", REGISTRY_ENTRY)
    registry.write_text(registry_text, encoding="utf-8")
    search_text = insert_before(search_helpers.read_text(encoding="utf-8"), "}\n\n\ndef dispatch_search", DISPATCH_ENTRY)
    search_helpers.write_text(search_text, encoding="utf-8")
    locomo_text = insert_before(
        locomo_search.read_text(encoding="utf-8"),
        '        "mem9": generic_text_search,\n',
        LOCOMO_DISPATCH_ENTRY,
    )
    locomo_search.write_text(locomo_text, encoding="utf-8")
    print({"status": "installed", "repo": str(repo), "backend": "argon"})


if __name__ == "__main__":
    main()
