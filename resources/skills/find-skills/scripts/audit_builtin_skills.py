#!/usr/bin/env python3
"""Audit built-in skill folders without external dependencies."""

from __future__ import annotations

import argparse
import ast
import json
import re
from pathlib import Path


FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*", re.DOTALL)
RESOURCE_REF_RE = re.compile(r"`((?:scripts|references|assets)/[^`\s]+)(?:\s+[^`]*)?`")


def parse_frontmatter(text: str) -> dict[str, str]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise ValueError("missing YAML frontmatter")
    data: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if not line.strip() or line.startswith(" "):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            continue
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def audit_skill(skill_dir: Path) -> dict[str, object]:
    errors: list[str] = []
    warnings: list[str] = []
    skill_md = skill_dir / "SKILL.md"

    if not skill_md.exists():
        return {"skill": skill_dir.name, "pass": False, "errors": ["SKILL.md missing"], "warnings": warnings}

    text = skill_md.read_text(encoding="utf-8")
    try:
        meta = parse_frontmatter(text)
        name = meta.get("name", "")
        description = meta.get("description", "")
        if not re.match(r"^[a-z0-9-]+$", name):
            errors.append("frontmatter name must be kebab-case")
        if not description:
            errors.append("frontmatter description is missing")
        if len(description) > 1024:
            errors.append("frontmatter description is longer than 1024 characters")
    except Exception as exc:
        errors.append(str(exc))

    for ref in RESOURCE_REF_RE.findall(text):
        if not (skill_dir / ref).exists():
            errors.append(f"referenced resource missing: {ref}")

    scripts_dir = skill_dir / "scripts"
    if scripts_dir.exists():
        for py_file in scripts_dir.glob("*.py"):
            try:
                ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
            except SyntaxError as exc:
                errors.append(f"python syntax error in {py_file.relative_to(skill_dir)}: {exc.msg}")

    cache_files = [
        item.relative_to(skill_dir).as_posix()
        for item in skill_dir.rglob("*")
        if item.name == "__pycache__" or item.suffix == ".pyc"
    ]
    if cache_files:
        errors.append("cache files should not be bundled: " + ", ".join(cache_files[:5]))

    if not (skill_dir / "agents" / "openai.yaml").exists():
        warnings.append("agents/openai.yaml missing")

    return {"skill": skill_dir.name, "pass": not errors, "errors": errors, "warnings": warnings}


def audit(root: Path) -> dict[str, object]:
    if not root.exists():
        raise FileNotFoundError(root)
    skill_dirs = sorted([item for item in root.iterdir() if item.is_dir() and (item / "SKILL.md").exists()])
    results = [audit_skill(skill_dir) for skill_dir in skill_dirs]
    return {"pass": all(result["pass"] for result in results), "skill_count": len(results), "results": results}


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit built-in Zen AI skill folders.")
    parser.add_argument("root", nargs="?", default=".", help="Path to resources/skills.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    args = parser.parse_args()

    report = audit(Path(args.root))
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        status = "passed" if report["pass"] else "failed"
        print(f"skill audit {status}: {report['skill_count']} skill(s)")
        for result in report["results"]:
            marker = "OK" if result["pass"] else "FAIL"
            print(f"- {marker} {result['skill']}")
            for error in result["errors"]:
                print(f"  error: {error}")
            for warning in result["warnings"]:
                print(f"  warning: {warning}")
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
