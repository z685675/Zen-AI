#!/usr/bin/env python3
"""Validate a generated DOCX package, relationships, and field safety."""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import zipfile
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET


PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
CORE_TITLE_NS = "http://purl.org/dc/elements/1.1/"
REL_TYPE_HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
EXTERNAL_FIELD_TYPES = {"DATABASE", "DDE", "DDEAUTO", "INCLUDEPICTURE", "INCLUDETEXT", "LINK", "RD"}
FALSE_VALUES = {"0", "false", "no", "off"}
REQUIRED_PARTS = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
MARKDOWN_LITERAL_PATTERNS = {
    "heading": re.compile(r"^\s{0,3}#{1,6}\s+\S"),
    "strong_emphasis": re.compile(r"(?:\*\*|__)\S.+?(?:\*\*|__)"),
    "fenced_code": re.compile(r"^\s*```"),
    "pipe_table_separator": re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$"),
    "unordered_list_marker": re.compile(r"^\s*[-+*]\s+\S"),
}


def duplicate_values(values: list[str]) -> list[str]:
    return sorted(value for value, count in Counter(values).items() if value and count > 1)


def relationship_source(rels_path: str) -> str:
    if rels_path == "_rels/.rels":
        return ""
    marker = "/_rels/"
    if marker not in rels_path or not rels_path.endswith(".rels"):
        return ""
    prefix, leaf = rels_path.split(marker, 1)
    return posixpath.join(prefix, leaf[:-5])


def resolve_relationship_target(source: str, target: str) -> str:
    target_path = unquote(urlsplit(target).path).replace("\\", "/")
    if target_path.startswith("/"):
        return posixpath.normpath(target_path.lstrip("/"))
    return posixpath.normpath(posixpath.join(posixpath.dirname(source), target_path))


def field_type(instruction: str) -> str:
    match = re.match(r"\s*([A-Za-z]+)", instruction)
    return match.group(1).upper() if match else "UNKNOWN"


def extract_fields(parsed_parts: dict[str, ET.Element]) -> tuple[list[dict[str, object]], list[dict[str, str]]]:
    fields: list[dict[str, object]] = []
    structure_errors: list[dict[str, str]] = []
    fld_char_tag = f"{{{WORD_NS}}}fldChar"
    fld_simple_tag = f"{{{WORD_NS}}}fldSimple"
    instr_text_tag = f"{{{WORD_NS}}}instrText"
    text_tag = f"{{{WORD_NS}}}t"
    char_type_attr = f"{{{WORD_NS}}}fldCharType"
    instruction_attr = f"{{{WORD_NS}}}instr"

    for part, root in parsed_parts.items():
        if not part.startswith("word/") or not part.endswith(".xml"):
            continue

        for node in root.iter(fld_simple_tag):
            instruction = node.get(instruction_attr, "")
            result = "".join(text.text or "" for text in node.iter(text_tag))
            fields.append(
                {
                    "part": part,
                    "kind": "simple",
                    "type": field_type(instruction),
                    "instruction": instruction.strip(),
                    "result": result,
                    "cached": bool(re.sub(r"\s+", "", result)),
                }
            )

        stack: list[dict[str, object]] = []
        for node in root.iter():
            if node.tag == fld_char_tag:
                char_type = node.get(char_type_attr, "").lower()
                if char_type == "begin":
                    stack.append({"part": part, "kind": "complex", "instruction": "", "result": "", "in_result": False})
                elif char_type == "separate":
                    if not stack:
                        structure_errors.append({"part": part, "error": "Field separator has no matching begin marker."})
                    else:
                        stack[-1]["in_result"] = True
                elif char_type == "end":
                    if not stack:
                        structure_errors.append({"part": part, "error": "Field end has no matching begin marker."})
                    else:
                        completed = stack.pop()
                        instruction = str(completed.pop("instruction", ""))
                        result = str(completed.pop("result", ""))
                        completed.pop("in_result", None)
                        completed.update(
                            {
                                "type": field_type(instruction),
                                "instruction": instruction.strip(),
                                "result": result,
                                "cached": bool(re.sub(r"\s+", "", result)),
                            }
                        )
                        fields.append(completed)
            elif node.tag == instr_text_tag and stack:
                for active in reversed(stack):
                    if not bool(active["in_result"]):
                        active["instruction"] = str(active["instruction"]) + (node.text or "")
                        break
            elif node.tag == text_tag and stack:
                text = node.text or ""
                for active in stack:
                    if bool(active["in_result"]):
                        active["result"] = str(active["result"]) + text

        for _ in stack:
            structure_errors.append({"part": part, "error": "Field begin has no matching end marker."})

    return fields, structure_errors


def update_fields_enabled(settings: ET.Element | None) -> bool:
    if settings is None:
        return False
    value_attr = f"{{{WORD_NS}}}val"
    for node in settings.iter(f"{{{WORD_NS}}}updateFields"):
        if node.get(value_attr, "true").strip().lower() not in FALSE_VALUES:
            return True
    return False


def risky_fields(fields: list[dict[str, object]]) -> list[dict[str, object]]:
    risky: list[dict[str, object]] = []
    for field in fields:
        kind = str(field.get("type", "UNKNOWN")).upper()
        instruction = str(field.get("instruction", ""))
        upper = instruction.upper()
        external_hyperlink = kind == "HYPERLINK" and (
            "FILE:" in upper or "\\\\" in instruction or bool(re.search(r"[A-Za-z]:\\", instruction))
        )
        if kind in EXTERNAL_FIELD_TYPES or external_hyperlink:
            risky.append({key: value for key, value in field.items() if key != "result"})
    return risky


def paragraph_text(paragraph: ET.Element) -> str:
    return "".join(node.text or "" for node in paragraph.iter(f"{{{WORD_NS}}}t"))


def markdown_literals(document: ET.Element | None) -> list[dict[str, object]]:
    if document is None:
        return []

    findings: list[dict[str, object]] = []
    for index, paragraph in enumerate(document.findall(f".//{{{WORD_NS}}}p"), start=1):
        text = paragraph_text(paragraph).strip()
        if not text:
            continue
        matched = [name for name, pattern in MARKDOWN_LITERAL_PATTERNS.items() if pattern.search(text)]
        if matched:
            findings.append({"paragraph": index, "markers": matched, "text": text[:240]})
    return findings


def normalize_visible_text(value: str) -> str:
    normalized = re.sub(r"^\s{0,3}#{1,6}\s+", "", value.strip())
    normalized = re.sub(r"^\s*(?:[-+*]|\d+[.)])\s+", "", normalized)
    normalized = normalized.replace("**", "").replace("__", "").replace("`", "")
    return re.sub(r"\s+", " ", normalized).strip()


def probable_raw_source_dump_tables(document: ET.Element | None) -> list[dict[str, object]]:
    if document is None:
        return []

    table_paragraph_ids = {
        id(paragraph)
        for table in document.findall(f".//{{{WORD_NS}}}tbl")
        for paragraph in table.findall(f".//{{{WORD_NS}}}p")
    }
    body_texts = {
        normalize_visible_text(paragraph_text(paragraph))
        for paragraph in document.findall(f".//{{{WORD_NS}}}p")
        if id(paragraph) not in table_paragraph_ids and len(normalize_visible_text(paragraph_text(paragraph))) >= 20
    }

    findings: list[dict[str, object]] = []
    for index, table in enumerate(document.findall(f".//{{{WORD_NS}}}tbl"), start=1):
        rows = table.findall(f"{{{WORD_NS}}}tr")
        cell_counts = [len(row.findall(f"{{{WORD_NS}}}tc")) for row in rows]
        if len(rows) < 8 or not cell_counts or max(cell_counts) != 1:
            continue

        lines = [
            paragraph_text(cell)
            for row in rows
            for cell in row.findall(f"{{{WORD_NS}}}tc")
        ]
        marker_lines = sum(
            1
            for line in lines
            if any(pattern.search(line.strip()) for pattern in MARKDOWN_LITERAL_PATTERNS.values())
        )
        normalized_lines = [normalize_visible_text(line) for line in lines]
        comparable_lines = [line for line in normalized_lines if len(line) >= 20]
        overlap_count = sum(1 for line in comparable_lines if line in body_texts)
        overlap_ratio = overlap_count / len(comparable_lines) if comparable_lines else 0.0

        if marker_lines >= 2 or overlap_ratio >= 0.5:
            findings.append(
                {
                    "table": index,
                    "rows": len(rows),
                    "columns": 1,
                    "markdown_marker_rows": marker_lines,
                    "body_overlap_ratio": round(overlap_ratio, 3),
                }
            )
    return findings


def validate_docx(path: Path, allow_markdown_literals: bool = False) -> dict[str, object]:
    errors: list[dict[str, object] | str] = []
    warnings: list[dict[str, object] | str] = []
    counts: dict[str, object] = {}
    field_summary: dict[str, object] = {}

    if not path.is_file():
        return {"pass": False, "file": str(path), "errors": ["File does not exist."], "warnings": [], "counts": {}}
    if path.stat().st_size == 0:
        return {"pass": False, "file": str(path), "errors": ["File is empty."], "warnings": [], "counts": {}}

    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            name_set = set(names)
            parsed_parts: dict[str, ET.Element] = {}

            duplicate_entries = duplicate_values(names)
            if duplicate_entries:
                errors.append({"duplicate_zip_entries": duplicate_entries})

            missing_parts = sorted(REQUIRED_PARTS - name_set)
            if missing_parts:
                errors.append({"missing_required_parts": missing_parts})

            corrupt_entry = archive.testzip()
            if corrupt_entry:
                errors.append({"crc_failure": corrupt_entry})

            xml_parse_errors: list[dict[str, str]] = []
            for name in names:
                if not name.endswith((".xml", ".rels")):
                    continue
                try:
                    parsed_parts[name] = ET.fromstring(archive.read(name))
                except Exception as exc:
                    xml_parse_errors.append({"part": name, "error": str(exc)})
            if xml_parse_errors:
                errors.append({"xml_parse_errors": xml_parse_errors})

            missing_targets: list[dict[str, str | None]] = []
            duplicate_relationship_ids: list[dict[str, object]] = []
            unsafe_external_relationships: list[dict[str, str | None]] = []
            web_hyperlinks: list[dict[str, str | None]] = []
            for name, root in parsed_parts.items():
                if not name.endswith(".rels"):
                    continue
                relationships = root.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
                repeated_ids = duplicate_values([relationship.get("Id", "") for relationship in relationships])
                if repeated_ids:
                    duplicate_relationship_ids.append({"part": name, "ids": repeated_ids})

                source = relationship_source(name)
                for relationship in relationships:
                    target = relationship.get("Target", "")
                    if relationship.get("TargetMode", "").lower() == "external":
                        item = {
                            "part": name,
                            "id": relationship.get("Id"),
                            "type": relationship.get("Type"),
                            "target": target,
                        }
                        scheme = urlsplit(target).scheme.lower()
                        if relationship.get("Type") == REL_TYPE_HYPERLINK and scheme in {"http", "https", "mailto"}:
                            web_hyperlinks.append(item)
                        else:
                            unsafe_external_relationships.append(item)
                        continue
                    resolved = resolve_relationship_target(source, target)
                    if resolved not in name_set:
                        missing_targets.append(
                            {"part": name, "id": relationship.get("Id"), "target": target, "resolved": resolved}
                        )

            if duplicate_relationship_ids:
                errors.append({"duplicate_relationship_ids": duplicate_relationship_ids})
            if missing_targets:
                errors.append({"missing_relationship_targets": missing_targets})
            if unsafe_external_relationships:
                errors.append({"unsafe_external_relationships": unsafe_external_relationships})
            if web_hyperlinks:
                warnings.append({"external_web_hyperlinks": web_hyperlinks})

            fields, field_structure_errors = extract_fields(parsed_parts)
            if field_structure_errors:
                errors.append({"field_structure_errors": field_structure_errors})

            risky = risky_fields(fields)
            if risky:
                errors.append({"external_or_linked_fields": risky})

            settings = parsed_parts.get("word/settings.xml")
            open_time_update = update_fields_enabled(settings)
            if open_time_update:
                errors.append(
                    {
                        "open_time_field_update": (
                            "word/settings.xml enables w:updateFields; Word may display an external-field warning on open."
                        )
                    }
                )

            uncached_toc = [
                {key: value for key, value in field.items() if key != "result"}
                for field in fields
                if field.get("type") == "TOC" and not field.get("cached")
            ]
            if uncached_toc:
                errors.append(
                    {
                        "uncached_toc_fields": {
                            "fields": uncached_toc,
                            "message": "Update the TOC once in Word and save it, or replace it with a static contents section.",
                        }
                    }
                )

            type_counts = Counter(str(field.get("type", "UNKNOWN")) for field in fields)
            field_summary = {
                "count": len(fields),
                "types": dict(sorted(type_counts.items())),
                "toc_fields": type_counts.get("TOC", 0),
                "cached_toc_fields": sum(1 for field in fields if field.get("type") == "TOC" and field.get("cached")),
                "open_time_update": open_time_update,
            }

            document = parsed_parts.get("word/document.xml")
            paragraphs = document.findall(f".//{{{WORD_NS}}}p") if document is not None else []
            visible_paragraphs = [paragraph_text(paragraph).strip() for paragraph in paragraphs]
            visible_paragraphs = [text for text in visible_paragraphs if text]
            visible_text = "\n".join(visible_paragraphs)
            if not visible_text:
                errors.append("The DOCX body has no visible text.")
            if "\ufffd" in visible_text:
                errors.append("Unicode replacement characters are visible in the DOCX body.")

            heading_count = 0
            list_paragraph_count = 0
            for paragraph in paragraphs:
                properties = paragraph.find(f"{{{WORD_NS}}}pPr")
                if properties is None:
                    continue
                style = properties.find(f"{{{WORD_NS}}}pStyle")
                style_name = style.get(f"{{{WORD_NS}}}val", "") if style is not None else ""
                if re.match(r"^(?:Heading|Title)\d*$", style_name, re.I):
                    heading_count += 1
                if properties.find(f"{{{WORD_NS}}}numPr") is not None:
                    list_paragraph_count += 1
            if len(visible_paragraphs) >= 12 and heading_count == 0:
                warnings.append("Long DOCX content has no native heading paragraphs.")

            core_properties = parsed_parts.get("docProps/core.xml")
            title_node = (
                core_properties.find(f"{{{CORE_TITLE_NS}}}title") if core_properties is not None else None
            )
            document_title = normalize_visible_text(title_node.text or "") if title_node is not None else ""
            visible_title_count = sum(
                1 for text in visible_paragraphs if normalize_visible_text(text) == document_title
            ) if document_title else 0
            if document_title and visible_title_count != 1:
                errors.append(
                    {
                        "visible_title_count": {
                            "title": document_title,
                            "expected": 1,
                            "actual": visible_title_count,
                        }
                    }
                )

            visible_markdown = markdown_literals(document)
            if visible_markdown and not allow_markdown_literals:
                errors.append(
                    {
                        "visible_markdown_literals": {
                            "message": "Convert Markdown syntax into native Word formatting before delivery.",
                            "findings": visible_markdown[:50],
                        }
                    }
                )

            source_dump_tables = probable_raw_source_dump_tables(document)
            if source_dump_tables:
                errors.append(
                    {
                        "probable_raw_source_dump_tables": {
                            "message": "A one-column table appears to repeat the document's Markdown source.",
                            "findings": source_dump_tables,
                        }
                    }
                )

            counts.update(
                {
                    "zip_entries": len(names),
                    "xml_parts": len(parsed_parts),
                    "paragraphs": len(paragraphs),
                    "visible_paragraphs": len(visible_paragraphs),
                    "visible_characters": len(visible_text),
                    "heading_paragraphs": heading_count,
                    "list_paragraphs": list_paragraph_count,
                    "visible_title_occurrences": visible_title_count,
                    "tables": len(document.findall(f".//{{{WORD_NS}}}tbl")) if document is not None else 0,
                    "sections": len(document.findall(f".//{{{WORD_NS}}}sectPr")) if document is not None else 0,
                    "drawings": len(document.findall(f".//{{{DRAWING_NS}}}graphic")) if document is not None else 0,
                    "media": sum(1 for name in names if name.startswith("word/media/") and not name.endswith("/")),
                    "visible_markdown_literals": len(visible_markdown),
                    "probable_raw_source_dump_tables": len(source_dump_tables),
                }
            )
    except (OSError, zipfile.BadZipFile) as exc:
        errors.append({"package_open_error": str(exc)})

    return {
        "pass": not errors,
        "file": str(path),
        "size": path.stat().st_size,
        "errors": errors,
        "warnings": warnings,
        "fields": field_summary,
        "counts": counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a generated DOCX OOXML package.")
    parser.add_argument("docx", type=Path, help="DOCX file to validate.")
    parser.add_argument(
        "--allow-markdown-literals",
        action="store_true",
        help="Allow visible Markdown syntax when the document intentionally teaches or quotes Markdown.",
    )
    args = parser.parse_args()

    report = validate_docx(args.docx, args.allow_markdown_literals)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
