#!/usr/bin/env python3
"""Check whether a Markdown draft is ready to become a professional DOCX."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def read_text(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")


def analyze(text: str, expected_sections: list[str]) -> dict[str, object]:
    lines = text.splitlines()
    headings = [line.strip() for line in lines if re.match(r"^#{1,4}\s+\S", line)]
    h1 = [line for line in headings if line.startswith("# ")]
    h2 = [line for line in headings if line.startswith("## ")]
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip() and not p.lstrip().startswith("#")]
    long_paragraphs = [p for p in paragraphs if len(re.sub(r"\s+", "", p)) > 260]
    table_lines = [line for line in lines if "|" in line and re.search(r"\S\s*\|\s*\S", line)]
    bullet_lines = [line for line in lines if re.match(r"^\s*[-*+]\s+\S", line)]

    warnings: list[str] = []
    if not h1:
        warnings.append("No H1 title found.")
    if len(h2) < 3:
        warnings.append("Fewer than 3 H2 sections; long business documents usually need clearer sections.")
    if long_paragraphs:
        warnings.append(f"{len(long_paragraphs)} paragraph(s) are too long for skimming.")
    if len(table_lines) == 0 and re.search(r"timeline|计划|对比|事项|预算|风险|里程碑|action", text, re.I):
        warnings.append("Content mentions structured items but has no table.")

    lower_text = text.lower()
    missing = [section for section in expected_sections if section.lower() not in lower_text]
    if missing:
        warnings.append("Missing expected sections: " + ", ".join(missing))

    score = 100 - len(warnings) * 8
    score = max(0, score)
    return {
        "pass": score >= 76,
        "score": score,
        "headings": len(headings),
        "h2_sections": len(h2),
        "paragraphs": len(paragraphs),
        "tables": len(table_lines),
        "bullets": len(bullet_lines),
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check document draft structure.")
    parser.add_argument("input", help="Markdown/text file, or '-' for stdin.")
    parser.add_argument("--expect", default="", help="Comma-separated section names expected in the draft.")
    args = parser.parse_args()
    expected_sections = [item.strip() for item in args.expect.split(",") if item.strip()]
    result = analyze(read_text(args.input), expected_sections)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
