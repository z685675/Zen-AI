#!/usr/bin/env python3
"""Validate and normalize a PPTX deck spec before calling create_file."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


ALLOWED_LAYOUTS = {
    "cover",
    "agenda",
    "section",
    "insight",
    "cards",
    "process",
    "timeline",
    "network",
    "matrix",
    "schedule",
    "route",
    "comparison",
    "metric",
    "chart",
    "image",
    "quote",
    "summary",
}
ALLOWED_ACCENTS = ["blue", "green", "amber", "purple", "cyan", "coral", "red", "slate"]
MAX_BULLETS_BY_LAYOUT = {
    "agenda": 6,
    "cards": 4,
    "process": 5,
    "timeline": 5,
    "network": 6,
    "matrix": 4,
    "schedule": 6,
    "route": 6,
    "comparison": 6,
    "metric": 3,
    "chart": 6,
    "image": 4,
    "quote": 2,
    "summary": 5,
    "insight": 5,
}
GENERIC_TITLE_RE = re.compile(
    r"^(background|overview|analysis|summary|introduction|conclusion|背景|概述|分析|总结|介绍|结论|目录|大纲)$",
    re.IGNORECASE,
)
PLACEHOLDER_RE = re.compile(
    r"\b(?:draft presentation|presentation deck|key insight|key message|key signal|data point|"
    r"translate this number into a decision)\b",
    re.IGNORECASE,
)
NUMERIC_SIGNAL_RE = re.compile(r"(?:\d|[%％$￥¥€£]|\b(?:k|m|b|x|pp|bps)\b|倍|天|周|月|年|小时|分钟)", re.IGNORECASE)
BULLET_UNITS_BY_LAYOUT = {
    "agenda": 38,
    "cards": 48,
    "process": 48,
    "timeline": 56,
    "network": 48,
    "matrix": 48,
    "schedule": 52,
    "route": 52,
    "comparison": 52,
    "metric": 28,
    "chart": 42,
    "image": 48,
    "quote": 72,
    "summary": 52,
    "insight": 52,
}
MIN_TOTAL_UNITS_BY_LAYOUT = {
    "agenda": 26,
    "cards": 42,
    "process": 36,
    "timeline": 42,
    "network": 36,
    "matrix": 42,
    "schedule": 36,
    "route": 36,
    "comparison": 48,
    "metric": 12,
    "chart": 24,
    "image": 20,
    "summary": 34,
    "insight": 42,
}


def layout_family(layout: str) -> str:
    if layout in {"cover", "section", "quote"}:
        return "narrative"
    if layout in {"metric", "chart", "image"}:
        return "evidence"
    if layout in {"cards", "comparison", "matrix"}:
        return "structured"
    if layout in {"agenda", "process", "timeline", "schedule", "route"}:
        return "sequence"
    if layout == "network":
        return "open"
    return "open"


def read_json(path: str) -> Any:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    return json.loads(raw)


def text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def display_units(value: str) -> float:
    """Approximate rendered width in CJK-character units."""
    units = 0.0
    for char in value:
        if char.isspace():
            units += 0.3
        elif unicodedata.east_asian_width(char) in {"W", "F"}:
            units += 1.0
        elif unicodedata.category(char).startswith("P"):
            units += 0.45
        else:
            units += 0.55
    return units


def split_first(value: str, pattern: str) -> tuple[str, str] | None:
    match = re.search(pattern, value)
    if not match:
        return None
    return value[: match.start()].strip(), value[match.end() :].strip()


def metric_parts(value: str) -> tuple[str, str, str] | None:
    pair = split_first(value, r"[:：|｜]")
    if not pair:
        return None
    label, remainder = pair
    value_note = split_first(remainder, r"[|｜]")
    metric_value, note = value_note if value_note else (remainder, "")
    return label, metric_value, note


def is_compact_metric(value: str) -> bool:
    parts = metric_parts(value)
    if not parts:
        return False
    label, metric_value, note = parts
    return bool(
        label
        and metric_value
        and NUMERIC_SIGNAL_RE.search(metric_value)
        and display_units(label) <= 18
        and display_units(metric_value) <= 16
        and display_units(note) <= 32
    )


def contains_placeholder(value: str) -> bool:
    return bool(value and PLACEHOLDER_RE.search(value))


def normalize_layout(layout: str, index: int, total: int, title: str, bullets: list[str]) -> str:
    if layout in ALLOWED_LAYOUTS:
        return layout
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
    if re.search(r"compare|comparison|对比|竞品|before|after|vs\.?", lowered):
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


def coerce_spec(data: Any) -> tuple[str, list[dict[str, Any]]]:
    if isinstance(data, dict):
        slides = data.get("slides", [])
        title = text(data.get("title")) or "Presentation"
    elif isinstance(data, list):
        slides = data
        title = "Presentation"
    else:
        raise ValueError("Deck spec must be a JSON object with slides or a JSON array of slides.")
    if not isinstance(slides, list):
        raise ValueError("slides must be an array.")
    return title, slides


def validate(data: Any, strict: bool) -> dict[str, Any]:
    deck_title, raw_slides = coerce_spec(data)
    errors: list[str] = []
    warnings: list[str] = []
    suggestions: list[str] = []
    repairs: list[str] = []
    normalized: list[dict[str, Any]] = []

    if not raw_slides:
        errors.append("Deck has no slides.")

    total = len(raw_slides)
    if total > 30:
        errors.append("Deck has more than 30 slides; split it into sections or simplify.")
    if total < 3:
        warnings.append("Deck has fewer than 3 slides; it may feel incomplete.")
    if total > 18:
        warnings.append("Deck has more than 18 slides; verify the audience really needs this length.")

    for index, item in enumerate(raw_slides):
        if not isinstance(item, dict):
            errors.append(f"Slide {index + 1} is not an object.")
            continue

        title = text(item.get("title")) or f"Slide {index + 1}"
        bullets = item.get("bullets", [])
        if not isinstance(bullets, list):
            warnings.append(f"Slide {index + 1} bullets is not an array; coerced to a single bullet.")
            bullets = [bullets]
        clean_bullets = [text(b) for b in bullets if text(b)]
        layout = normalize_layout(text(item.get("layout")), index, total, title, clean_bullets)
        if layout == "metric" and clean_bullets and not all(is_compact_metric(bullet) for bullet in clean_bullets):
            fallback_layout = "cards" if 2 <= len(clean_bullets) <= 4 else "insight"
            warnings.append(
                f"Slide {index + 1} uses metric for non-numeric or oversized values; normalized to {fallback_layout}."
            )
            repairs.append(f"Slide {index + 1}: metric -> {fallback_layout}")
            layout = fallback_layout
        max_bullets = MAX_BULLETS_BY_LAYOUT.get(layout, 5)

        if display_units(title) > 32:
            warnings.append(f"Slide {index + 1} title is long; make it a sharper conclusion.")
        if GENERIC_TITLE_RE.match(title):
            warnings.append(f"Slide {index + 1} title is generic; rewrite it as a message.")
        if contains_placeholder(title):
            errors.append(f"Slide {index + 1} title contains generator placeholder copy.")
        if len(clean_bullets) > max_bullets:
            warnings.append(f"Slide {index + 1} has {len(clean_bullets)} bullets; {layout} works best with {max_bullets}.")
            clean_bullets = clean_bullets[:max_bullets]
        bullet_budget = BULLET_UNITS_BY_LAYOUT.get(layout, 52)
        for bullet_index, bullet in enumerate(clean_bullets):
            units = display_units(bullet)
            if units > bullet_budget:
                warnings.append(
                    f"Slide {index + 1} bullet {bullet_index + 1} is too dense for {layout} "
                    f"({units:.1f} > {bullet_budget} CJK-equivalent units)."
                )
            if units > bullet_budget * 1.65:
                errors.append(
                    f"Slide {index + 1} bullet {bullet_index + 1} cannot remain readable in {layout}; shorten it or split the slide."
                )
            if contains_placeholder(bullet):
                errors.append(f"Slide {index + 1} bullet {bullet_index + 1} contains generator placeholder copy.")

        total_body_units = sum(display_units(bullet) for bullet in clean_bullets)
        minimum_body_units = MIN_TOTAL_UNITS_BY_LAYOUT.get(layout, 0)
        if (
            strict
            and minimum_body_units
            and total_body_units < minimum_body_units
            and not text(item.get("takeaway"))
            and layout not in {"cover", "section", "quote"}
        ):
            warnings.append(
                f"Slide {index + 1} is underfilled for {layout} "
                f"({total_body_units:.1f} < {minimum_body_units} CJK-equivalent units); "
                "add evidence, interpretation, or an action instead of enlarging empty containers."
            )

        subtitle = text(item.get("subtitle"))
        takeaway = text(item.get("takeaway"))
        if display_units(takeaway) > 52:
            warnings.append(f"Slide {index + 1} takeaway is too long for a compact callout band.")
        if contains_placeholder(subtitle) or contains_placeholder(takeaway):
            errors.append(f"Slide {index + 1} contains visible generator placeholder copy.")
        if layout == "chart":
            for bullet_index, bullet in enumerate(clean_bullets):
                if not NUMERIC_SIGNAL_RE.search(bullet):
                    warnings.append(f"Slide {index + 1} chart row {bullet_index + 1} has no numeric value.")
        if layout == "network" and len(clean_bullets) not in range(3, 7):
            warnings.append(f"Slide {index + 1} network works best with 3-6 node | detail items.")
        if layout == "matrix" and len(clean_bullets) != 4:
            warnings.append(f"Slide {index + 1} matrix should contain exactly four quadrant | detail items.")
        if layout == "route" and len(clean_bullets) not in range(3, 7):
            warnings.append(f"Slide {index + 1} route works best with 3-6 stop | milestone: detail items.")
        if layout in {"schedule", "route"}:
            for bullet_index, bullet in enumerate(clean_bullets):
                if not split_first(bullet, r"[|｜]"):
                    warnings.append(
                        f"Slide {index + 1} {layout} row {bullet_index + 1} should use "
                        f"{'time' if layout == 'schedule' else 'stop'} | milestone: detail."
                    )

        accent = text(item.get("accent"))
        if accent and accent not in ALLOWED_ACCENTS:
            warnings.append(
                f"Slide {index + 1} uses unknown accent '{accent}'; omit it to use the document style palette."
            )

        normalized.append(
            {
                "title": title,
                "subtitle": subtitle or None,
                "layout": layout,
                "takeaway": takeaway or None,
                "visual": text(item.get("visual")) or None,
                "image_asset_id": text(item.get("image_asset_id")) or None,
                "accent": accent if accent in ALLOWED_ACCENTS else None,
                "bullets": clean_bullets,
                "notes": text(item.get("notes")) or None,
                "preserve_content": item.get("preserve_content") is True or None,
                "template_slide_number": item.get("template_slide_number"),
                "target_slide_number": item.get("target_slide_number"),
            }
        )

    normalized = [{k: v for k, v in slide.items() if v not in (None, "", [])} for slide in normalized]

    layouts = [slide["layout"] for slide in normalized]
    if layouts and layouts[0] != "cover":
        warnings.append("First slide is not cover; consider starting with a cover slide.")
    if layouts and layouts[-1] not in {"summary", "section"}:
        warnings.append("Last slide is not a summary or closing slide.")
    for i in range(1, len(layouts)):
        if layouts[i] == layouts[i - 1] and layouts[i] not in {"section"}:
            warnings.append(f"Slides {i} and {i + 1} repeat layout '{layouts[i]}'; vary the rhythm.")
    content_layouts = [layout for layout in layouts if layout not in {"cover", "section"}]
    required_layout_types = 6 if len(normalized) >= 13 else 5 if len(normalized) >= 9 else 4 if len(normalized) >= 6 else 0
    if required_layout_types and len(set(layouts)) < required_layout_types:
        warnings.append(
            f"Deck uses {len(set(layouts))} layout types; a {len(normalized)}-slide deck should use at least "
            f"{required_layout_types} distinct compositions."
        )
    if content_layouts:
        dominant_layout = max(set(content_layouts), key=content_layouts.count)
        dominant_ratio = content_layouts.count(dominant_layout) / len(content_layouts)
        if len(content_layouts) >= 6 and dominant_ratio > 0.45:
            warnings.append(
                f"Layout '{dominant_layout}' dominates {dominant_ratio:.0%} of content slides; "
                "vary the reading path, not just colors."
            )

    families = [layout_family(layout) for layout in layouts]
    required_families = 4 if len(normalized) >= 12 else 3 if len(normalized) >= 8 else 0
    if required_families and len(set(families)) < required_families:
        warnings.append(
            f"Deck uses only {len(set(families))} composition families; include at least {required_families} "
            "of narrative, evidence, structured, sequence, and open pages."
        )
    for index in range(2, len(families)):
        if families[index] == families[index - 1] == families[index - 2] and families[index] != "narrative":
            warnings.append(
                f"Slides {index - 1}-{index + 1} repeat the '{families[index]}' composition family; change the visual rhythm."
            )
            break

    content_slides = [s for s in normalized if s["layout"] not in {"cover", "section"}]
    if content_slides:
        takeaway_ratio = sum(1 for s in content_slides if s.get("takeaway")) / len(content_slides)
        visual_layouts = {
            "comparison",
            "process",
            "timeline",
            "network",
            "matrix",
            "schedule",
            "route",
            "metric",
            "chart",
            "image",
        }
        visual_ratio = sum(1 for s in content_slides if s.get("visual") or s["layout"] in visual_layouts) / len(
            content_slides
        )
        if takeaway_ratio < 0.7:
            warnings.append("Most content slides should include takeaway to prevent label-only slides.")
        if visual_ratio < 0.45:
            suggestions.append("Add visual cues to more slides: chart, flow, comparison, metric, or example.")

        document_type = text(data.get("document_type")) if isinstance(data, dict) else ""
        visual_style = text(data.get("visual_style")) if isinstance(data, dict) else ""
        visual_storytelling_expected = document_type in {
            "brand-campaign",
            "product-launch",
            "culture-feature",
            "event-keynote",
            "creative-portfolio",
        } or visual_style in {"brand", "creative", "culture", "editorial", "bold"}
        image_slides = [s for s in content_slides if s.get("image_asset_id")]
        if visual_storytelling_expected and len(content_slides) >= 5 and len(image_slides) < 2:
            suggestions.append(
                "This topic benefits from visual storytelling; source or generate at least two distinct topic-relevant "
                "images and assign them with assets plus image_asset_id when usable assets are available."
            )

    score = 100 - len(errors) * 20 - len(warnings) * 5 - len(suggestions) * 2
    score = max(0, min(100, score))
    threshold = 85 if strict else 75
    passed = not errors and score >= threshold

    create_file_args = {"format": "pptx", "title": deck_title, "slides": normalized}
    if isinstance(data, dict):
        for key in (
            "visual_style",
            "document_type",
            "style_mode",
            "brand_theme",
            "render_validation",
            "assets",
            "pptx_style_reference",
            "pptx_template",
        ):
            if data.get(key) not in (None, "", {}):
                create_file_args[key] = data[key]

    return {
        "pass": passed,
        "score": score,
        "threshold": threshold,
        "title": deck_title,
        "errors": errors,
        "warnings": warnings,
        "suggestions": suggestions,
        "repairs": repairs,
        "layout_counts": {layout: layouts.count(layout) for layout in sorted(set(layouts))},
        "create_file_args": create_file_args,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Zen AI PPTX deck JSON spec.")
    parser.add_argument("spec", help="Path to deck JSON, or '-' for stdin.")
    parser.add_argument("--strict", action="store_true", help="Require a higher quality threshold.")
    parser.add_argument("--write-normalized", help="Write normalized create_file args to this JSON path.")
    args = parser.parse_args()

    try:
        report = validate(read_json(args.spec), args.strict)
    except Exception as exc:
        print(json.dumps({"pass": False, "errors": [str(exc)]}, ensure_ascii=False, indent=2))
        return 2

    if args.write_normalized:
        Path(args.write_normalized).write_text(
            json.dumps(report["create_file_args"], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
