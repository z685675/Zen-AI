#!/usr/bin/env python3
"""Build and validate a traceable research source matrix."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter
from io import StringIO
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


URL_RE = re.compile(r"https?://[^\s)<>\]]+")
CITATION_RE = re.compile(r"\[S(\d+)\]", re.IGNORECASE)
SOURCE_HEADING_RE = re.compile(
    r"(?im)^\s{0,3}(?:#{1,6}\s*)?(?:sources?|references?|来源|参考来源|参考资料)\s*:?\s*$"
)
LIMITATIONS_HEADING_RE = re.compile(
    r"(?im)^\s{0,3}(?:#{1,6}\s*)?(?:limitations?|constraints?|局限|局限性|限制)\s*:?\s*$"
)
TRACKING_QUERY_KEYS = {"fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"}
VALID_CONFIDENCE = {"high", "medium", "low", "unknown"}


def read_text(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")


def clean_url(url: str) -> str:
    return url.strip().rstrip(".,;:!?\"'")


def canonicalize_url(url: str) -> str:
    parsed = urlparse(clean_url(url))
    filtered_query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_QUERY_KEYS
    ]
    path = parsed.path.rstrip("/") or "/"
    return urlunparse(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            path,
            "",
            urlencode(filtered_query, doseq=True),
            "",
        )
    )


def source_host(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.")


def source_title(url: str) -> str:
    return source_host(url) or url


def is_valid_web_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc) and " " not in parsed.netloc


def is_search_result_url(url: str) -> bool:
    parsed = urlparse(url)
    host = parsed.netloc.lower().removeprefix("www.")
    path = parsed.path.lower()
    query_keys = {key.lower() for key, _ in parse_qsl(parsed.query, keep_blank_values=True)}

    if host.startswith("google.") and path.startswith("/search"):
        return True
    if host in {"bing.com", "cn.bing.com"} and path.startswith("/search"):
        return True
    if host in {"baidu.com", "m.baidu.com"} and path == "/s":
        return True
    if host.endswith("duckduckgo.com") and ("q" in query_keys or path.startswith("/html")):
        return True
    if host == "search.yahoo.com" and path.startswith("/search"):
        return True
    if host.endswith("sogou.com") and path.startswith("/web"):
        return True
    if host in {"so.com", "www.so.com"} and path.startswith("/s"):
        return True
    return False


def normalize_supports(item: dict[str, Any]) -> list[str]:
    raw_supports = item.get("supports")
    if isinstance(raw_supports, list):
        return [str(value).strip() for value in raw_supports if str(value).strip()]
    if isinstance(raw_supports, str) and raw_supports.strip():
        return [raw_supports.strip()]

    claim = str(item.get("claim") or item.get("finding") or item.get("note") or "").strip()
    return [claim] if claim else []


def normalize_source(item: dict[str, Any], index: int) -> dict[str, Any]:
    url = clean_url(str(item.get("url") or item.get("link") or ""))
    title = str(item.get("title") or item.get("name") or source_title(url) or f"Source {index}").strip()
    confidence = str(item.get("confidence") or "medium").strip().lower()
    limitations = item.get("limitations") or item.get("limitation") or []
    if isinstance(limitations, str):
        limitations = [limitations.strip()] if limitations.strip() else []
    elif isinstance(limitations, list):
        limitations = [str(value).strip() for value in limitations if str(value).strip()]
    else:
        limitations = []

    return {
        "id": f"S{index}",
        "title": title,
        "publisher": str(item.get("publisher") or source_title(url)).strip() or None,
        "url": url or None,
        "date": str(item.get("date") or item.get("published") or "").strip() or None,
        "supports": normalize_supports(item),
        "confidence": confidence,
        "limitations": limitations,
    }


def parse_sources(raw: str) -> list[dict[str, Any]]:
    stripped = raw.lstrip()
    if stripped.startswith("[") or stripped.startswith("{"):
        data = json.loads(raw)
        if isinstance(data, dict):
            data = data.get("sources", [])
        if not isinstance(data, list):
            raise ValueError("JSON input must be a list or an object with sources.")
        return [
            normalize_source(item if isinstance(item, dict) else {"title": str(item)}, index + 1)
            for index, item in enumerate(data)
        ]

    lines = raw.splitlines()
    if lines and "," in lines[0] and "\n" in raw:
        rows = list(csv.DictReader(StringIO(raw)))
        if rows and rows[0]:
            return [normalize_source(row, index + 1) for index, row in enumerate(rows)]

    sources: list[dict[str, Any]] = []
    for index, match in enumerate(URL_RE.finditer(raw), start=1):
        url = clean_url(match.group(0))
        start = max(0, raw.rfind("\n", 0, match.start()))
        end = raw.find("\n", match.end())
        context = raw[start : end if end != -1 else len(raw)].strip()
        sources.append(normalize_source({"url": url, "note": context}, index))
    return sources


def validate_report(
    report: str,
    source_urls: set[str],
    source_ids: set[str],
    strict: bool,
    errors: list[str],
    warnings: list[str],
) -> dict[str, Any]:
    def issue(message: str, blocking: bool = True) -> None:
        (errors if strict and blocking else warnings).append(message)

    if not SOURCE_HEADING_RE.search(report):
        issue("Report is missing a Sources or References section.")
    if not LIMITATIONS_HEADING_RE.search(report):
        issue("Report is missing a Limitations section.")

    report_urls = [clean_url(match.group(0)) for match in URL_RE.finditer(report)]
    canonical_report_urls = {
        canonicalize_url(url) for url in report_urls if is_valid_web_url(url) and not is_search_result_url(url)
    }
    if not report_urls:
        issue("Report contains no clickable source URLs.")
    if any(is_search_result_url(url) for url in report_urls):
        issue("Report cites a search-results page instead of a direct source.")

    unknown_urls = sorted(canonical_report_urls - source_urls)
    if unknown_urls:
        issue(f"Report cites {len(unknown_urls)} URL(s) that are absent from the source matrix.")

    cited_source_urls = canonical_report_urls & source_urls
    coverage_ratio = len(cited_source_urls) / len(source_urls) if source_urls else 0.0
    minimum_cited_sources = min(3, len(source_urls))
    if source_urls and (len(cited_source_urls) < minimum_cited_sources or coverage_ratio < 0.5):
        issue(
            "Report source coverage is too low: "
            f"{len(cited_source_urls)}/{len(source_urls)} matrix URLs are linked."
        )

    cited_ids = {f"S{match.group(1)}".upper() for match in CITATION_RE.finditer(report)}
    unknown_ids = sorted(cited_ids - source_ids)
    if unknown_ids:
        issue(f"Report references unknown source IDs: {', '.join(unknown_ids)}.")

    return {
        "url_count": len(report_urls),
        "direct_url_count": len(canonical_report_urls),
        "matrix_url_coverage": round(coverage_ratio, 3),
        "citation_id_count": len(cited_ids),
    }


def build_matrix(
    raw: str,
    *,
    strict: bool = False,
    min_sources: int = 8,
    min_domains: int = 3,
    report: str | None = None,
) -> dict[str, Any]:
    sources = parse_sources(raw)
    errors: list[str] = []
    warnings: list[str] = []

    def issue(message: str, blocking: bool = True) -> None:
        (errors if strict and blocking else warnings).append(message)

    if not sources:
        issue("No sources found.")

    missing_urls = [source["id"] for source in sources if not source.get("url")]
    invalid_urls = [
        source["id"]
        for source in sources
        if source.get("url") and not is_valid_web_url(str(source["url"]))
    ]
    search_result_ids = [
        source["id"]
        for source in sources
        if source.get("url") and is_search_result_url(str(source["url"]))
    ]
    if missing_urls:
        issue(f"Sources without direct URLs: {', '.join(missing_urls)}.")
    if invalid_urls:
        issue(f"Sources with invalid web URLs: {', '.join(invalid_urls)}.")
    if search_result_ids:
        issue(f"Search-results pages are not valid evidence sources: {', '.join(search_result_ids)}.")

    valid_direct_urls = [
        canonicalize_url(str(source["url"]))
        for source in sources
        if source.get("url")
        and is_valid_web_url(str(source["url"]))
        and not is_search_result_url(str(source["url"]))
    ]
    duplicate_urls = sorted(url for url, count in Counter(valid_direct_urls).items() if count > 1)
    if duplicate_urls:
        issue(f"Duplicate source URLs found after normalization: {len(duplicate_urls)}.")

    unique_urls = set(valid_direct_urls)
    domains = [source_host(url) for url in unique_urls if source_host(url)]
    domain_counts = Counter(domains)
    if len(unique_urls) < min_sources:
        issue(f"Only {len(unique_urls)} unique direct sources; strict minimum is {min_sources}.")
    if len(domain_counts) < min_domains:
        issue(f"Only {len(domain_counts)} source domains; strict minimum is {min_domains}.")
    if domains:
        dominant_domain, dominant_count = domain_counts.most_common(1)[0]
        concentration = dominant_count / len(domains)
        if concentration > 0.6 and len(domains) >= 3:
            warnings.append(
                f"Source concentration is high: {dominant_domain} supplies "
                f"{dominant_count}/{len(domains)} unique sources."
            )
    else:
        concentration = 0.0

    missing_supports = [source["id"] for source in sources if not source.get("supports")]
    if missing_supports and len(missing_supports) / max(len(sources), 1) > 0.2:
        issue(f"Too many sources lack a supported claim: {', '.join(missing_supports)}.")
    elif missing_supports:
        warnings.append(f"Sources without a supported claim: {', '.join(missing_supports)}.")

    missing_dates = [source["id"] for source in sources if not source.get("date")]
    if missing_dates:
        warnings.append(
            f"{len(missing_dates)}/{len(sources)} sources have no publication date; "
            "disclose timeliness risk for current topics."
        )

    invalid_confidence = [
        source["id"] for source in sources if str(source.get("confidence")).lower() not in VALID_CONFIDENCE
    ]
    if invalid_confidence:
        issue(
            f"Invalid confidence values for {', '.join(invalid_confidence)}; "
            f"use {', '.join(sorted(VALID_CONFIDENCE))}."
        )

    report_quality = None
    if report is not None:
        report_quality = validate_report(
            report,
            unique_urls,
            {source["id"].upper() for source in sources},
            strict,
            errors,
            warnings,
        )

    return {
        "source_count": len(sources),
        "unique_direct_source_count": len(unique_urls),
        "domain_count": len(domain_counts),
        "errors": errors,
        "warnings": warnings,
        "quality_gate": {
            "strict": strict,
            "passed": bool(sources) and not errors,
            "minimum_sources": min_sources,
            "minimum_domains": min_domains,
            "dominant_domain_ratio": round(concentration, 3),
            "report": report_quality,
        },
        "sources": sources,
        "report_citation_hint": (
            "Use [S1], [S2] citations and direct clickable URLs near current factual claims. "
            "Keep Sources and Limitations sections in the final report."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Create and validate a research source matrix.")
    parser.add_argument("input", help="Source JSON/CSV/notes file, or '-' for stdin.")
    parser.add_argument("--out", help="Write matrix JSON to this path.")
    parser.add_argument("--report", help="Validate a Markdown or text report against the source matrix.")
    parser.add_argument("--strict", action="store_true", help="Fail when evidence or report quality gates are unmet.")
    parser.add_argument("--min-sources", type=int, default=8, help="Minimum unique direct sources in strict mode.")
    parser.add_argument("--min-domains", type=int, default=3, help="Minimum source domains in strict mode.")
    args = parser.parse_args()

    if args.min_sources < 1 or args.min_domains < 1:
        parser.error("--min-sources and --min-domains must be positive integers.")

    report = read_text(args.report) if args.report else None
    result = build_matrix(
        read_text(args.input),
        strict=args.strict,
        min_sources=args.min_sources,
        min_domains=args.min_domains,
        report=report,
    )
    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
    print(output)

    if args.strict:
        return 0 if result["quality_gate"]["passed"] else 2
    return 0 if result["source_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
