#!/usr/bin/env python3
"""Validate PDF structure, text coverage, page content, and unsafe actions."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


MARKDOWN_LITERAL_PATTERNS = {
    "heading": re.compile(r"^\s{0,3}#{1,6}\s+\S"),
    "strong_emphasis": re.compile(r"(?:\*\*|__)\S.+?(?:\*\*|__)"),
    "fenced_code": re.compile(r"^\s*(?:```|~~~)"),
    "pipe_table_separator": re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$"),
}


def dereference(value: Any) -> Any:
    try:
        return value.get_object()
    except Exception:
        return value


def mapping_get(value: Any, key: str) -> Any:
    value = dereference(value)
    try:
        return dereference(value.get(key))
    except Exception:
        return None


def validate_pdf(
    path: Path,
    min_pages: int,
    expected_text: list[str],
    require_cjk: bool,
    single_title: bool = False,
    no_markdown_literals: bool = False,
) -> dict[str, object]:
    errors: list[dict[str, object] | str] = []
    warnings: list[dict[str, object] | str] = []
    counts: dict[str, object] = {}

    if not path.is_file():
        return {"pass": False, "file": str(path), "errors": ["File does not exist."], "warnings": [], "counts": {}}
    if path.stat().st_size == 0:
        return {"pass": False, "file": str(path), "errors": ["File is empty."], "warnings": [], "counts": {}}

    data = path.read_bytes()
    if not data.startswith(b"%PDF-"):
        errors.append("Missing PDF header.")
    if b"%%EOF" not in data[-2048:]:
        errors.append("Missing PDF EOF marker near the end of the file.")
    if b"/Linearized" in data[:2048]:
        warnings.append("Linearized PDF detected; verify incremental updates if the file is edited later.")

    try:
        from pypdf import PdfReader
        from pypdf.generic import ArrayObject, DictionaryObject
    except Exception as exc:
        errors.append({"validator_dependency_error": f"pypdf is required for full validation: {exc}"})
        return {
            "pass": False,
            "file": str(path),
            "size": path.stat().st_size,
            "errors": errors,
            "warnings": warnings,
            "counts": counts,
        }

    try:
        reader = PdfReader(str(path), strict=True)
    except Exception as exc:
        errors.append({"pdf_parse_error": str(exc)})
        return {
            "pass": False,
            "file": str(path),
            "size": path.stat().st_size,
            "errors": errors,
            "warnings": warnings,
            "counts": counts,
        }

    if reader.is_encrypted:
        errors.append("Encrypted PDFs are not accepted as generated deliverables.")

    page_count = len(reader.pages)
    if page_count < max(1, min_pages):
        errors.append({"page_count_below_requirement": {"required": max(1, min_pages), "actual": page_count}})

    root = dereference(reader.trailer.get("/Root"))
    unsafe_catalog_entries: list[str] = []
    for key in ("/OpenAction", "/AA"):
        if mapping_get(root, key) is not None:
            unsafe_catalog_entries.append(key)
    names = mapping_get(root, "/Names")
    if names is not None:
        for key in ("/JavaScript", "/EmbeddedFiles"):
            if mapping_get(names, key) is not None:
                unsafe_catalog_entries.append(f"/Names{key}")
    if unsafe_catalog_entries:
        errors.append({"unsafe_catalog_actions": unsafe_catalog_entries})

    page_texts: list[str] = []
    blank_pages: list[int] = []
    image_only_pages: list[int] = []
    font_names: set[str] = set()
    fonts_without_unicode_map: set[str] = set()
    image_count = 0
    web_links: list[dict[str, object]] = []
    unsafe_actions: list[dict[str, object]] = []
    markdown_literals: list[dict[str, object]] = []

    for page_index, page in enumerate(reader.pages, start=1):
        try:
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            if width <= 0 or height <= 0:
                errors.append({"invalid_page_box": {"page": page_index, "width": width, "height": height}})
        except Exception as exc:
            errors.append({"invalid_page_box": {"page": page_index, "error": str(exc)}})

        try:
            text = page.extract_text() or ""
        except Exception as exc:
            text = ""
            errors.append({"text_extraction_error": {"page": page_index, "error": str(exc)}})
        page_texts.append(text)
        if no_markdown_literals:
            for line_number, line in enumerate(text.splitlines(), start=1):
                matched = [name for name, pattern in MARKDOWN_LITERAL_PATTERNS.items() if pattern.search(line)]
                if matched:
                    markdown_literals.append(
                        {
                            "page": page_index,
                            "line": line_number,
                            "markers": matched,
                            "text": line[:240],
                        }
                    )

        resources = mapping_get(page, "/Resources")
        xobjects = mapping_get(resources, "/XObject") if resources is not None else None
        page_images = 0
        if isinstance(xobjects, DictionaryObject):
            for xobject in xobjects.values():
                if str(mapping_get(xobject, "/Subtype")) == "/Image":
                    page_images += 1
        image_count += page_images
        if len(re.sub(r"\s+", "", text)) < 3:
            if page_images:
                image_only_pages.append(page_index)
            else:
                blank_pages.append(page_index)

        fonts = mapping_get(resources, "/Font") if resources is not None else None
        if isinstance(fonts, DictionaryObject):
            for name, font_ref in fonts.items():
                font = dereference(font_ref)
                base_name = str(mapping_get(font, "/BaseFont") or name)
                font_names.add(base_name)
                subtype = str(mapping_get(font, "/Subtype") or "")
                if subtype in {"/Type0", "/TrueType"} and mapping_get(font, "/ToUnicode") is None:
                    fonts_without_unicode_map.add(base_name)

        page_actions = mapping_get(page, "/AA")
        if page_actions is not None:
            unsafe_actions.append({"page": page_index, "action": "/AA"})
        annotations = mapping_get(page, "/Annots")
        if isinstance(annotations, ArrayObject):
            for annotation_ref in annotations:
                annotation = dereference(annotation_ref)
                action = mapping_get(annotation, "/A")
                if action is None:
                    continue
                action_type = str(mapping_get(action, "/S") or "")
                if action_type == "/URI":
                    uri = str(mapping_get(action, "/URI") or "")
                    if re.match(r"^(?:https?|mailto):", uri, re.I):
                        web_links.append({"page": page_index, "uri": uri})
                    else:
                        unsafe_actions.append({"page": page_index, "action": action_type, "target": uri})
                elif action_type:
                    unsafe_actions.append({"page": page_index, "action": action_type})

    if blank_pages:
        errors.append({"blank_pages": blank_pages})
    if image_only_pages:
        warnings.append({"image_only_pages": image_only_pages})
    if unsafe_actions:
        errors.append({"unsafe_page_or_annotation_actions": unsafe_actions})
    if web_links:
        warnings.append({"external_web_links": web_links})

    full_text = "\n".join(page_texts)
    missing_expected = [value for value in expected_text if value not in full_text]
    if missing_expected:
        errors.append({"missing_expected_text": missing_expected})
    cjk_count = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", full_text))
    if require_cjk and cjk_count == 0:
        errors.append("No extractable CJK text found.")
    if "\ufffd" in full_text:
        errors.append("Unicode replacement characters were extracted from the PDF.")
    if require_cjk and fonts_without_unicode_map:
        errors.append({"fonts_without_to_unicode": sorted(fonts_without_unicode_map)})
    if markdown_literals:
        errors.append(
            {
                "visible_markdown_literals": {
                    "message": "Render Markdown as PDF structure instead of exposing authoring syntax.",
                    "findings": markdown_literals[:50],
                }
            }
        )

    metadata_title = ""
    try:
        metadata_title = str((reader.metadata.title if reader.metadata else "") or "").strip()
    except Exception:
        metadata_title = ""
    normalized_title = re.sub(r"\s+", " ", re.sub(r"\.pdf$", "", metadata_title, flags=re.I)).strip()
    normalized_text = re.sub(r"\s+", " ", full_text)
    title_occurrences = normalized_text.count(normalized_title) if normalized_title else 0
    if single_title:
        if not normalized_title:
            warnings.append("PDF metadata has no title, so visible-title duplication cannot be checked.")
        elif title_occurrences != 1:
            errors.append(
                {
                    "visible_title_count": {
                        "title": normalized_title,
                        "expected": 1,
                        "actual": title_occurrences,
                    }
                }
            )

    counts.update(
        {
            "pages": page_count,
            "text_characters": len(full_text),
            "cjk_characters": cjk_count,
            "fonts": len(font_names),
            "images": image_count,
            "web_links": len(web_links),
            "visible_markdown_literals": len(markdown_literals),
            "visible_title_occurrences": title_occurrences,
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
    parser = argparse.ArgumentParser(description="Validate a generated PDF deliverable.")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--min-pages", type=int, default=1)
    parser.add_argument("--expect-text", action="append", default=[])
    parser.add_argument("--require-cjk", action="store_true")
    parser.add_argument("--single-title", action="store_true")
    parser.add_argument("--no-markdown-literals", action="store_true")
    args = parser.parse_args()

    report = validate_pdf(
        args.pdf,
        args.min_pages,
        args.expect_text,
        args.require_cjk,
        args.single_title,
        args.no_markdown_literals,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
