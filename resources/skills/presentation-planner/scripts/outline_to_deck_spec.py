#!/usr/bin/env python3
"""Convert a Markdown outline or rough notes into a first-pass deck spec."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def read_text(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")


def clean_line(line: str) -> str:
    return re.sub(r"^\s*[-*+]\s+", "", line.strip())


def infer_layout(title: str, bullets: list[str], index: int, total: int) -> str:
    lowered = title.lower()
    if index == 0:
        return "cover"
    if re.search(r"agenda|目录|大纲|roadmap", lowered):
        return "agenda"
    if re.search(r"section|章节|篇章|part\s+\d+", lowered):
        return "section"
    if re.search(r"summary|总结|结论|next|下一步|行动", lowered) or index == total - 1:
        return "summary"
    if re.search(r"quote|引言|金句|观点|testimonial|客户评价", lowered):
        return "quote"
    if re.search(r"network|ecosystem map|关系网络|协作网络|生态网络|利益相关者|关系图谱", lowered):
        return "network"
    if re.search(r"matrix|quadrant|矩阵|象限|二维分析", lowered):
        return "matrix"
    if re.search(r"schedule|agenda by time|run of show|日程|议程安排|会期|排期|时段安排", lowered):
        return "schedule"
    if re.search(r"route|journey map|路径图|路线|旅程|动线|站点地图", lowered):
        return "route"
    if re.search(r"compare|comparison|对比|竞品|vs\.?|before|after", lowered):
        return "comparison"
    if re.search(r"chart|柱状图|条形图|趋势|占比|分布|数据图", lowered):
        return "chart"
    if re.search(r"metric|kpi|数据|指标|增长|收入|成本|转化|roi", lowered):
        return "metric"
    if re.search(r"timeline|时间线|里程碑|roadmap", lowered):
        return "timeline"
    if re.search(r"process|流程|步骤|路径|计划", lowered):
        return "process"
    if 3 <= len(bullets) <= 4:
        return "cards"
    return "insight"


def visual_hint(layout: str) -> str:
    return {
        "agenda": "numbered roadmap list",
        "cards": "three or four equal cards",
        "process": "horizontal process with milestones",
        "timeline": "milestone timeline",
        "network": "connected ecosystem with one shared hub",
        "matrix": "four-quadrant decision matrix",
        "schedule": "time-led program rows",
        "route": "two-level journey or spatial route",
        "comparison": "two-column contrast",
        "metric": "large number cards with implication",
        "chart": "horizontal bar chart",
        "quote": "large quote or customer proof page",
        "summary": "decision and next-action rows",
        "section": "full-bleed divider",
        "cover": "strong title with context tags",
    }.get(layout, "takeaway band plus evidence points")


def parse_markdown(raw: str, fallback_title: str) -> tuple[str, list[dict[str, object]]]:
    lines = raw.splitlines()
    deck_title = fallback_title
    slides: list[dict[str, object]] = []
    current: dict[str, object] | None = None

    for line in lines:
        heading = re.match(r"^(#{1,3})\s+(.+?)\s*$", line)
        if heading:
            level = len(heading.group(1))
            title = heading.group(2).strip()
            if level == 1 and not slides and current is None:
                deck_title = title
                continue
            if current:
                slides.append(current)
            current = {"title": title, "bullets": []}
            continue

        stripped = clean_line(line)
        if not stripped:
            continue
        if current is None:
            current = {"title": stripped[:36], "bullets": []}
        else:
            current.setdefault("bullets", [])
            current["bullets"].append(stripped)

    if current:
        slides.append(current)

    if not slides:
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", raw) if p.strip()]
        slides = [{"title": p[:36], "bullets": [p]} for p in paragraphs[:10]]

    if not slides or slides[0]["title"] != deck_title:
        slides.insert(0, {"title": deck_title, "layout": "cover", "bullets": []})

    if len(slides) >= 4 and not re.search(r"summary|总结|结论|下一步|行动", str(slides[-1].get("title", "")), re.I):
        slides.append({"title": "下一步行动需要清晰落地", "layout": "summary", "bullets": ["确认目标", "明确负责人", "设定复盘节奏"]})

    total = len(slides)
    normalized: list[dict[str, object]] = []
    for index, slide in enumerate(slides):
        bullets = [str(item).strip() for item in slide.get("bullets", []) if str(item).strip()]
        layout = str(slide.get("layout") or infer_layout(str(slide.get("title", "")), bullets, index, total))
        normalized.append(
            {
                "title": str(slide.get("title", f"Slide {index + 1}")).strip(),
                "subtitle": str(slide.get("subtitle", "")).strip() or None,
                "layout": layout,
                "takeaway": bullets[0] if bullets and layout not in {"cover", "agenda"} else None,
                "visual": visual_hint(layout),
                "bullets": bullets[:6],
            }
        )

    normalized = [{k: v for k, v in slide.items() if v not in (None, "", [])} for slide in normalized]
    return deck_title, normalized


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a first-pass deck spec from Markdown.")
    parser.add_argument("input", help="Markdown/text file, or '-' for stdin.")
    parser.add_argument("--title", default="Presentation", help="Fallback deck title.")
    parser.add_argument("--out", help="Write JSON output to this path.")
    args = parser.parse_args()

    title, slides = parse_markdown(read_text(args.input), args.title)
    result = {"title": title, "slides": slides}
    raw = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(raw, encoding="utf-8")
    print(raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
