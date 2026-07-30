#!/usr/bin/env python3
"""Extract likely action items from rough meeting notes or transcripts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ACTION_RE = re.compile(
    r"(TODO|Action|行动项|待办|跟进|负责|Owner|owner|截止|deadline|DDL|下周|明天|今天|尽快|推进|确认|整理|输出|发送|补充)",
    re.IGNORECASE,
)


def read_text(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")


def clean_task(line: str) -> str:
    line = re.sub(r"^\s*[-*+\d.)\]]+\s*", "", line.strip())
    line = re.sub(r"^(TODO|Action|行动项|待办)[:：-]\s*", "", line, flags=re.I)
    line = re.sub(r"@[\w\u4e00-\u9fff.-]+", "", line)
    line = re.sub(r"(?:负责人|owner|Owner)[:：]\s*[^\s,，;；。]+", "", line)
    line = re.sub(r"(?:截止|deadline|DDL|due)[:：]\s*[^,，;；。]+", "", line, flags=re.I)
    line = re.sub(r"\bP[0-3]\b|高优|低优|紧急|urgent|blocker", "", line, flags=re.I)
    return line.strip()


def parse_owner(line: str) -> str:
    match = re.search(r"(?:负责人|owner|Owner)[:：]\s*([^\s,，;；]+)", line)
    if match:
        return match.group(1)
    mention = re.search(r"@([\w\u4e00-\u9fff.-]+)", line)
    return mention.group(1) if mention else "TBD"


def parse_deadline(line: str) -> str:
    match = re.search(r"(?:截止|deadline|DDL|due)[:：]\s*([^,，;；。]+)", line, re.I)
    if match:
        value = re.sub(r"\bP[0-3]\b|高优|低优|紧急|urgent|blocker", "", match.group(1), flags=re.I)
        return value.strip(" .。") or "TBD"
    for term in ["今天", "明天", "本周", "下周", "月底", "尽快"]:
        if term in line:
            return term
    return "TBD"


def parse_priority(line: str) -> str:
    if re.search(r"P0|P1|高优|紧急|urgent|blocker", line, re.I):
        return "High"
    if re.search(r"P3|低优|optional|可选", line, re.I):
        return "Low"
    return "Medium"


def extract(text: str) -> dict[str, object]:
    items = []
    seen = set()
    for line in text.splitlines():
        if not ACTION_RE.search(line):
            continue
        task = clean_task(line)
        if not task or task in seen:
            continue
        seen.add(task)
        items.append(
            {
                "task": task,
                "owner": parse_owner(line),
                "deadline": parse_deadline(line),
                "priority": parse_priority(line),
                "notes": "",
            }
        )

    warnings = []
    if not items:
        warnings.append("No explicit action items found.")
    if any(item["owner"] == "TBD" for item in items):
        warnings.append("Some action items have no owner.")
    if any(item["deadline"] == "TBD" for item in items):
        warnings.append("Some action items have no deadline.")

    return {"action_items": items, "warnings": warnings}


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract action items from meeting notes.")
    parser.add_argument("input", help="Meeting notes/transcript file, or '-' for stdin.")
    parser.add_argument("--out", help="Write action item JSON to this path.")
    args = parser.parse_args()
    result = extract(read_text(args.input))
    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
