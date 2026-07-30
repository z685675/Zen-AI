#!/usr/bin/env python3
"""Normalize pasted CSV/TSV/JSON data into create_file-compatible rows."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from io import StringIO
from pathlib import Path
from typing import Any


def read_input(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def unique_headers(headers: list[str]) -> list[str]:
    result: list[str] = []
    seen: dict[str, int] = {}
    for index, header in enumerate(headers):
        base = clean_cell(header) or f"Column {index + 1}"
        count = seen.get(base, 0)
        seen[base] = count + 1
        result.append(base if count == 0 else f"{base} {count + 1}")
    return result


def parse_json(raw: str) -> list[list[str]]:
    data = json.loads(raw)
    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        data = data["rows"]
    if not isinstance(data, list):
        raise ValueError("JSON input must be a list or an object with rows.")
    if not data:
        return []
    if all(isinstance(item, dict) for item in data):
        headers = unique_headers(list(dict.fromkeys(key for row in data for key in row.keys())))
        return [headers] + [[clean_cell(row.get(header, "")) for header in headers] for row in data]
    if all(isinstance(item, list) for item in data):
        return [[clean_cell(cell) for cell in row] for row in data]
    raise ValueError("JSON rows must be all objects or all arrays.")


def parse_delimited(raw: str, delimiter: str | None) -> list[list[str]]:
    sample = raw[:4096]
    if delimiter is None:
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        except csv.Error:
            dialect = csv.excel_tab if "\t" in sample else csv.excel
    else:
        dialect = csv.excel()
        dialect.delimiter = delimiter
    return [[clean_cell(cell) for cell in row] for row in csv.reader(StringIO(raw), dialect)]


def looks_like_json(raw: str) -> bool:
    return raw.lstrip().startswith(("[", "{"))


def infer_type(values: list[str]) -> str:
    non_empty = [value for value in values if value]
    if not non_empty:
        return "empty"
    number_re = re.compile(r"^-?[$¥€]?\s*\d+(?:,\d{3})*(?:\.\d+)?%?$")
    date_re = re.compile(r"^\d{4}[-/年]\d{1,2}([-/月]\d{1,2}日?)?$")
    if sum(1 for value in non_empty if number_re.match(value)) / len(non_empty) >= 0.8:
        return "number"
    if sum(1 for value in non_empty if date_re.match(value)) / len(non_empty) >= 0.8:
        return "date"
    return "text"


def normalize(rows: list[list[str]], has_header: str) -> dict[str, Any]:
    warnings: list[str] = []
    rows = [row for row in rows if any(cell.strip() for cell in row)]
    if not rows:
        return {"rows": [], "profile": {"row_count": 0, "column_count": 0}, "warnings": ["No rows found."]}

    width = max(len(row) for row in rows)
    padded = [row + [""] * (width - len(row)) for row in rows]
    if any(len(row) != width for row in rows):
        warnings.append("Rows had inconsistent widths and were padded with empty cells.")

    if has_header == "no":
        headers = [f"Column {index + 1}" for index in range(width)]
        data_rows = padded
    else:
        headers = unique_headers(padded[0])
        data_rows = padded[1:]

    output_rows = [headers] + data_rows
    types = {headers[index]: infer_type([row[index] for row in data_rows]) for index in range(width)}
    duplicate_empty_cols = [headers[index] for index in range(width) if all(not row[index] for row in data_rows)]
    if duplicate_empty_cols:
        warnings.append(f"Empty data columns detected: {', '.join(duplicate_empty_cols[:5])}")

    return {
        "rows": output_rows,
        "profile": {
            "row_count": len(data_rows),
            "column_count": width,
            "inferred_types": types,
        },
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize table data for Zen AI XLSX creation.")
    parser.add_argument("input", help="CSV/TSV/JSON file, or '-' for stdin.")
    parser.add_argument("--format", choices=["auto", "csv", "tsv", "json"], default="auto")
    parser.add_argument("--has-header", choices=["yes", "no"], default="yes")
    parser.add_argument("--out", help="Write normalized JSON to this path.")
    args = parser.parse_args()

    raw = read_input(args.input)
    try:
        if args.format == "json" or (args.format == "auto" and looks_like_json(raw)):
            rows = parse_json(raw)
        else:
            delimiter = "\t" if args.format == "tsv" else "," if args.format == "csv" else None
            rows = parse_delimited(raw, delimiter)
        result = normalize(rows, args.has_header)
    except Exception as exc:
        result = {"rows": [], "profile": {}, "warnings": [str(exc)]}

    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
    print(output)
    return 0 if result.get("rows") else 1


if __name__ == "__main__":
    raise SystemExit(main())
