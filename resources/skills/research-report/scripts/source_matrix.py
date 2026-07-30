#!/usr/bin/env python3
"""Build a compact source matrix from JSON, CSV, or notes with URLs."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from io import StringIO
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


URL_RE = re.compile(r"https?://[^\s)>\]]+")


def read_text(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")


def source_title(url: str) -> str:
    host = urlparse(url).netloc or url
    return host.replace("www.", "")


def normalize_source(item: dict[str, Any], index: int) -> dict[str, Any]:
    url = str(item.get("url") or item.get("link") or "").strip()
    title = str(item.get("title") or item.get("name") or source_title(url) or f"Source {index}").strip()
    claim = str(item.get("claim") or item.get("finding") or item.get("note") or "").strip()
    return {
        "id": f"S{index}",
        "title": title,
        "url": url or None,
        "date": str(item.get("date") or item.get("published") or "").strip() or None,
        "supports": [claim] if claim else [],
        "confidence": str(item.get("confidence") or "medium").strip(),
    }


def parse_sources(raw: str) -> list[dict[str, Any]]:
    stripped = raw.lstrip()
    if stripped.startswith("[") or stripped.startswith("{"):
        data = json.loads(raw)
        if isinstance(data, dict):
            data = data.get("sources", [])
        if not isinstance(data, list):
            raise ValueError("JSON input must be a list or an object with sources.")
        return [normalize_source(item if isinstance(item, dict) else {"title": str(item)}, i + 1) for i, item in enumerate(data)]

    lines = raw.splitlines()
    if lines and "," in lines[0] and "\n" in raw:
        rows = list(csv.DictReader(StringIO(raw)))
        if rows and rows[0]:
            return [normalize_source(row, i + 1) for i, row in enumerate(rows)]

    sources: list[dict[str, Any]] = []
    for i, match in enumerate(URL_RE.finditer(raw), start=1):
        url = match.group(0).rstrip(".,;")
        start = max(0, raw.rfind("\n", 0, match.start()))
        end = raw.find("\n", match.end())
        context = raw[start : end if end != -1 else len(raw)].strip()
        sources.append(normalize_source({"url": url, "note": context}, i))
    return sources


def build_matrix(raw: str) -> dict[str, Any]:
    sources = parse_sources(raw)
    warnings: list[str] = []
    if not sources:
        warnings.append("No sources found.")
    if any(not source.get("url") for source in sources):
        warnings.append("Some sources have no URL; keep file names or bibliographic details in the report.")
    if any(not source.get("date") for source in sources):
        warnings.append("Some sources have no date; mark timeliness risk for current topics.")
    if len(sources) < 3:
        warnings.append("Fewer than 3 sources; research conclusions may be under-supported.")

    return {
        "source_count": len(sources),
        "warnings": warnings,
        "sources": sources,
        "report_citation_hint": "Use [S1], [S2] style citations in findings and keep uncertainty visible.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a research source matrix.")
    parser.add_argument("input", help="Source JSON/CSV/notes file, or '-' for stdin.")
    parser.add_argument("--out", help="Write matrix JSON to this path.")
    args = parser.parse_args()
    result = build_matrix(read_text(args.input))
    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
    print(output)
    return 0 if result["source_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
