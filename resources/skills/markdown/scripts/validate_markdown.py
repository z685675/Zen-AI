#!/usr/bin/env python3
"""Validate Markdown encoding, structure, tables, and links."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit


CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$")
FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\)")
UNSAFE_SCHEMES = {"data", "javascript", "vbscript"}
WEB_SCHEMES = {"http", "https", "mailto"}


def split_pipe_row(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|") and not value.endswith(r"\|"):
        value = value[:-1]

    cells: list[str] = []
    current: list[str] = []
    escaped = False
    in_code = False
    for character in value:
        if escaped:
            current.append(character)
            escaped = False
        elif character == "\\":
            current.append(character)
            escaped = True
        elif character == "`":
            current.append(character)
            in_code = not in_code
        elif character == "|" and not in_code:
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(character)
    cells.append("".join(current).strip())
    return cells


def resolve_local_link(document: Path, target: str) -> Path | None:
    split = urlsplit(target)
    if split.scheme or target.startswith(("#", "//")):
        return None
    decoded = unquote(split.path)
    if not decoded:
        return None
    candidate = Path(decoded)
    return candidate if candidate.is_absolute() else document.parent / candidate


def validate_markdown(
    path: Path,
    strict: bool = False,
    check_links: bool = False,
    expected_text: list[str] | None = None,
) -> dict[str, object]:
    errors: list[dict[str, object] | str] = []
    warnings: list[dict[str, object] | str] = []
    counts: dict[str, object] = {}
    expected_text = expected_text or []

    if not path.is_file():
        return {"pass": False, "file": str(path), "errors": ["File does not exist."], "warnings": [], "counts": {}}
    if path.stat().st_size == 0:
        return {"pass": False, "file": str(path), "errors": ["File is empty."], "warnings": [], "counts": {}}

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        return {
            "pass": False,
            "file": str(path),
            "errors": [{"utf8_decode_error": str(exc)}],
            "warnings": [],
            "counts": {},
        }

    if not text.strip():
        errors.append("Markdown has no visible content.")
    if CONTROL_RE.search(text):
        errors.append("Markdown contains unsupported control characters.")
    if "\ufffd" in text:
        errors.append("Markdown contains Unicode replacement characters.")
    if text != unicodedata.normalize("NFC", text):
        warnings.append("Markdown text is not NFC-normalized Unicode.")

    missing_expected = [value for value in expected_text if value not in text]
    if missing_expected:
        errors.append({"missing_expected_text": missing_expected})

    lines = text.splitlines()
    headings: list[dict[str, object]] = []
    heading_names: Counter[str] = Counter()
    heading_jumps: list[dict[str, int]] = []
    active_fence: tuple[str, int, int] | None = None
    fence_count = 0
    previous_level = 0
    separator_indexes: list[int] = []

    for index, line in enumerate(lines, start=1):
        fence = FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            if active_fence is None:
                active_fence = (marker[0], len(marker), index)
                fence_count += 1
            elif marker[0] == active_fence[0] and len(marker) >= active_fence[1]:
                active_fence = None
            continue
        if active_fence is not None:
            continue

        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            title = heading.group(2).strip().rstrip("#").strip()
            headings.append({"line": index, "level": level, "title": title})
            heading_names[re.sub(r"\s+", " ", title).casefold()] += 1
            if previous_level and level > previous_level + 1:
                heading_jumps.append({"line": index, "from": previous_level, "to": level})
            previous_level = level
        if TABLE_SEPARATOR_RE.match(line):
            separator_indexes.append(index - 1)

    if active_fence is not None:
        errors.append({"unclosed_code_fence": {"line": active_fence[2], "marker": active_fence[0] * active_fence[1]}})

    h1_count = sum(1 for heading in headings if heading["level"] == 1)
    if strict and h1_count != 1:
        errors.append({"top_level_heading_count": {"expected": 1, "actual": h1_count}})
    elif h1_count > 1:
        warnings.append({"multiple_top_level_headings": h1_count})
    if heading_jumps:
        target = errors if strict else warnings
        target.append({"heading_level_jumps": heading_jumps})
    repeated_headings = sorted(name for name, count in heading_names.items() if name and count > 1)
    if repeated_headings:
        warnings.append({"duplicate_heading_text": repeated_headings})

    malformed_tables: list[dict[str, object]] = []
    for separator_index in separator_indexes:
        if separator_index == 0:
            malformed_tables.append({"line": separator_index + 1, "error": "separator has no header row"})
            continue
        expected_columns = len(split_pipe_row(lines[separator_index - 1]))
        separator_columns = len(split_pipe_row(lines[separator_index]))
        if expected_columns != separator_columns:
            malformed_tables.append(
                {
                    "line": separator_index + 1,
                    "header_columns": expected_columns,
                    "separator_columns": separator_columns,
                }
            )
            continue
        row_index = separator_index + 1
        while row_index < len(lines) and "|" in lines[row_index] and lines[row_index].strip():
            columns = len(split_pipe_row(lines[row_index]))
            if columns != expected_columns:
                malformed_tables.append(
                    {"line": row_index + 1, "expected_columns": expected_columns, "actual_columns": columns}
                )
            row_index += 1
    if malformed_tables:
        errors.append({"malformed_pipe_tables": malformed_tables})

    unsafe_links: list[dict[str, str | int]] = []
    missing_local_links: list[dict[str, str | int]] = []
    web_link_count = 0
    local_link_count = 0
    for match in LINK_RE.finditer(text):
        target = match.group(1).strip("<>")
        scheme = urlsplit(target).scheme.lower()
        line = text.count("\n", 0, match.start()) + 1
        if scheme in UNSAFE_SCHEMES:
            unsafe_links.append({"line": line, "target": target})
        elif scheme in WEB_SCHEMES:
            web_link_count += 1
        else:
            local = resolve_local_link(path, target)
            if local is not None:
                local_link_count += 1
                if check_links and not local.exists():
                    missing_local_links.append({"line": line, "target": target})
    if unsafe_links:
        errors.append({"unsafe_links": unsafe_links})
    if missing_local_links:
        errors.append({"missing_local_link_targets": missing_local_links})

    counts.update(
        {
            "lines": len(lines),
            "characters": len(text),
            "headings": len(headings),
            "h1_headings": h1_count,
            "code_fences": fence_count,
            "tables": len(separator_indexes),
            "web_links": web_link_count,
            "local_links": local_link_count,
        }
    )
    return {
        "pass": not errors,
        "file": str(path),
        "size": path.stat().st_size,
        "errors": errors,
        "warnings": warnings,
        "counts": counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a generated Markdown deliverable.")
    parser.add_argument("markdown", type=Path)
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--check-links", action="store_true")
    parser.add_argument("--expect-text", action="append", default=[])
    args = parser.parse_args()

    report = validate_markdown(args.markdown, args.strict, args.check_links, args.expect_text)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
