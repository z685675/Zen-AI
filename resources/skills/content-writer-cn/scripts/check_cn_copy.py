#!/usr/bin/env python3
"""Check Chinese copy for specificity, readability, and weak marketing language."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


CLICHES = [
    "赋能",
    "全场景",
    "全链路",
    "生态",
    "闭环",
    "抓手",
    "重塑",
    "颠覆",
    "引爆",
    "心智",
    "私域",
    "降本增效",
    "极致体验",
]
CTA_TERMS = ["点击", "关注", "预约", "咨询", "购买", "下载", "报名", "评论", "私信", "了解更多"]


def read_text(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")


def analyze(text: str, platform: str) -> dict[str, object]:
    stripped_lines = [line.strip() for line in text.splitlines() if line.strip()]
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    warnings: list[str] = []
    suggestions: list[str] = []

    first = stripped_lines[0] if stripped_lines else ""
    if not first:
        warnings.append("内容为空。")
    elif len(first) > 45:
        warnings.append("开头太长，前一句需要更快进入场景或利益点。")
    if len(paragraphs) <= 1 and len(text) > 260:
        warnings.append("段落过少，移动端阅读会吃力。")

    long_paragraphs = [p for p in paragraphs if len(re.sub(r"\s+", "", p)) > 180]
    if long_paragraphs:
        warnings.append(f"有 {len(long_paragraphs)} 段过长，建议拆成更短段落。")

    found_cliches = [term for term in CLICHES if term in text]
    if found_cliches:
        warnings.append("检测到偏空的营销词：" + "、".join(found_cliches[:8]))

    concrete_markers = len(re.findall(r"\d+|案例|例如|步骤|清单|对比|原因|方法|模板", text))
    if concrete_markers < 2 and len(text) > 180:
        suggestions.append("增加数字、案例、步骤或对比，让内容更具体。")

    if platform in {"xiaohongshu", "小红书"} and not re.search(r"我|你|姐妹|新手|避坑|亲测|真实", text):
        suggestions.append("小红书内容可以更像真实经验，补充第一人称或具体场景。")
    if platform in {"wechat", "公众号"} and len(stripped_lines) < 6 and len(text) > 500:
        suggestions.append("公众号长文需要更清晰的小标题和转场。")
    if platform in {"video", "短视频"} and not re.search(r"镜头|画面|旁白|字幕|转场", text):
        suggestions.append("短视频脚本需要补充画面、旁白或字幕节奏。")

    if not any(term in text for term in CTA_TERMS) and len(text) > 180:
        suggestions.append("如果目标是转化，补一个自然的下一步动作。")

    score = 100 - len(warnings) * 10 - len(suggestions) * 4
    score = max(0, min(100, score))
    return {
        "pass": score >= 76,
        "score": score,
        "platform": platform or "general",
        "paragraph_count": len(paragraphs),
        "warnings": warnings,
        "suggestions": suggestions,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Chinese copy quality.")
    parser.add_argument("input", help="Draft text file, or '-' for stdin.")
    parser.add_argument("--platform", default="general", help="wechat, xiaohongshu, video, product, or general.")
    args = parser.parse_args()
    result = analyze(read_text(args.input), args.platform)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
