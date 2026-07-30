#!/usr/bin/env python3
"""Estimate whether extracted PDF text is reliable enough to summarize."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def read_text(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8", errors="replace")


def analyze(text: str) -> dict[str, object]:
    chars = len(text)
    lines = [line.rstrip() for line in text.splitlines()]
    non_empty = [line for line in lines if line.strip()]
    replacement_count = text.count("\ufffd")
    box_count = sum(text.count(ch) for ch in ["□", "■"])
    page_markers = len(re.findall(r"(?:page\s*\d+|第\s*\d+\s*页|\f)", text, re.I))
    table_like = [line for line in non_empty if "\t" in line or "|" in line or len(re.findall(r"\s{2,}", line)) >= 2]
    very_short_ratio = (sum(1 for line in non_empty if len(line.strip()) <= 3) / len(non_empty)) if non_empty else 1
    digit_dense_lines = [line for line in non_empty if len(re.findall(r"\d", line)) >= 8]

    warnings: list[str] = []
    if chars < 800:
        warnings.append("Extracted text is very short; the PDF may be scanned or extraction failed.")
    if replacement_count + box_count > 0:
        warnings.append("Replacement or box characters detected; OCR/text extraction may be noisy.")
    if very_short_ratio > 0.35:
        warnings.append("Many very short lines detected; layout extraction may be fragmented.")
    if page_markers == 0 and chars > 3000:
        warnings.append("No page markers detected; add page references manually when citing.")
    if table_like:
        warnings.append("Table-like lines detected; convert important tables into structured rows before analysis.")

    score = 100
    score -= 30 if chars < 800 else 0
    score -= min(25, (replacement_count + box_count) * 2)
    score -= 15 if very_short_ratio > 0.35 else 0
    score -= 8 if page_markers == 0 and chars > 3000 else 0
    score = max(0, score)

    return {
        "pass": score >= 70,
        "score": score,
        "char_count": chars,
        "line_count": len(non_empty),
        "page_marker_count": page_markers,
        "table_like_line_count": len(table_like),
        "digit_dense_line_count": len(digit_dense_lines),
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check quality of extracted PDF text.")
    parser.add_argument("input", help="Extracted text file, or '-' for stdin.")
    args = parser.parse_args()
    result = analyze(read_text(args.input))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
