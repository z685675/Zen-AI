#!/usr/bin/env python3
"""Load a built-in workbook template and prepare create_file rows."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "assets" / "workbook-templates"


def template_files() -> list[Path]:
    return sorted(TEMPLATE_DIR.glob("*.json"))


def load_template(name: str) -> dict:
    path = TEMPLATE_DIR / (name if name.endswith(".json") else f"{name}.json")
    if not path.exists():
        available = ", ".join(item.stem for item in template_files())
        raise FileNotFoundError(f"template not found: {name}. Available: {available}")
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare rows from a built-in workbook template.")
    parser.add_argument("template", nargs="?", help="Template name, e.g. project-tracker.")
    parser.add_argument("--title", help="Override workbook title.")
    parser.add_argument("--out", help="Write prepared JSON to this path.")
    parser.add_argument("--list", action="store_true", help="List available templates.")
    args = parser.parse_args()

    if args.list:
        for path in template_files():
            print(path.stem)
        return 0

    if not args.template:
        parser.error("template is required unless --list is used")

    spec = load_template(args.template)
    if args.title:
        spec["title"] = args.title

    output = json.dumps(spec, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
