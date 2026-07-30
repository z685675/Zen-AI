#!/usr/bin/env python3
"""Validate the OOXML package integrity of a generated PPTX file."""

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
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
THEME_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
SLIDE_LAYOUT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
SLIDE_MASTER_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
REL_TYPE_HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
PLACEHOLDER_RE = re.compile(
    r"\b(?:draft presentation|presentation deck|key insight|key message|key signal|data point|"
    r"translate this number into a decision)\b",
    re.IGNORECASE,
)
MARKDOWN_LITERAL_RE = re.compile(r"(?:^|\n)\s{0,3}(?:#{1,6}\s+|```|~~~)|(?:\*\*|__)\S.+?(?:\*\*|__)")


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


def duplicate_values(values: list[str]) -> list[str]:
    return sorted(value for value, count in Counter(values).items() if value and count > 1)


def validate_pptx(
    path: Path,
    expected_slides: int | None = None,
    strict_visual: bool = False,
) -> dict[str, object]:
    errors: list[dict[str, object] | str] = []
    warnings: list[dict[str, object] | str] = []
    counts: dict[str, object] = {}

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

            corrupt_entry = archive.testzip()
            if corrupt_entry:
                errors.append({"crc_failure": corrupt_entry})

            xml_parse_errors: list[dict[str, str]] = []
            for name in names:
                if not name.endswith((".xml", ".rels")):
                    continue
                try:
                    parsed_parts[name] = ET.fromstring(archive.read(name))
                except Exception as exc:  # pragma: no cover - parser supplies platform-specific details
                    xml_parse_errors.append({"part": name, "error": str(exc)})
            if xml_parse_errors:
                errors.append({"xml_parse_errors": xml_parse_errors})

            missing_targets: list[dict[str, str | None]] = []
            duplicate_relationship_ids: list[dict[str, object]] = []
            theme_relationships: list[dict[str, str]] = []
            relationships_by_source: dict[str, list[dict[str, str]]] = {}
            unsafe_external_relationships: list[dict[str, str]] = []
            external_web_hyperlinks: list[dict[str, str]] = []
            for name, root in parsed_parts.items():
                if not name.endswith(".rels"):
                    continue
                relationships = root.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
                repeated_ids = duplicate_values([relationship.get("Id", "") for relationship in relationships])
                if repeated_ids:
                    duplicate_relationship_ids.append({"part": name, "ids": repeated_ids})

                source = relationship_source(name)
                for relationship in relationships:
                    if relationship.get("TargetMode") == "External":
                        item = {
                            "part": name,
                            "id": relationship.get("Id", ""),
                            "type": relationship.get("Type", ""),
                            "target": relationship.get("Target", ""),
                        }
                        scheme = urlsplit(item["target"]).scheme.lower()
                        if item["type"] == REL_TYPE_HYPERLINK and scheme in {"http", "https", "mailto"}:
                            external_web_hyperlinks.append(item)
                        else:
                            unsafe_external_relationships.append(item)
                        continue
                    target = relationship.get("Target", "")
                    resolved = resolve_relationship_target(source, target)
                    relationships_by_source.setdefault(source, []).append(
                        {
                            "part": name,
                            "id": relationship.get("Id", ""),
                            "type": relationship.get("Type", ""),
                            "target": target,
                            "resolved": resolved,
                        }
                    )
                    if relationship.get("Type") == THEME_REL_TYPE:
                        theme_relationships.append(
                            {
                                "part": name,
                                "source": source,
                                "target": target,
                                "resolved": resolved,
                            }
                        )
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
            if external_web_hyperlinks:
                warnings.append({"external_web_hyperlinks": external_web_hyperlinks})

            content_types = parsed_parts.get("[Content_Types].xml")
            if content_types is None:
                errors.append("Missing [Content_Types].xml.")
            else:
                override_parts = [
                    unquote(node.get("PartName", "")).lstrip("/")
                    for node in content_types.findall(f"{{{CONTENT_TYPES_NS}}}Override")
                ]
                duplicate_overrides = duplicate_values(override_parts)
                if duplicate_overrides:
                    errors.append({"duplicate_content_type_overrides": duplicate_overrides})
                missing_override_targets = sorted(part for part in override_parts if part and part not in name_set)
                if missing_override_targets:
                    errors.append({"missing_content_type_targets": missing_override_targets})

            shared_notes_master_themes: list[dict[str, object]] = []
            for relationship in theme_relationships:
                if not relationship["source"].startswith("ppt/notesMasters/"):
                    continue
                other_owners = [
                    candidate["source"]
                    for candidate in theme_relationships
                    if candidate["resolved"] == relationship["resolved"]
                    and candidate["source"] != relationship["source"]
                ]
                if other_owners:
                    shared_notes_master_themes.append(
                        {
                            "part": relationship["part"],
                            "theme": relationship["resolved"],
                            "also_referenced_by": sorted(set(other_owners)),
                        }
                    )
            if shared_notes_master_themes:
                errors.append({"shared_notes_master_themes": shared_notes_master_themes})

            duplicate_shape_ids: list[dict[str, object]] = []
            negative_extents: list[dict[str, object]] = []
            placeholder_copy: list[dict[str, str]] = []
            expanding_text_boxes: list[dict[str, str]] = []
            ellipsis_text_boxes: list[dict[str, str]] = []
            runs_without_explicit_size: list[dict[str, str]] = []
            slides_without_visible_content: list[str] = []
            visible_markdown_literals: list[dict[str, str]] = []
            replacement_character_slides: list[str] = []
            text_box_count = 0
            autofit_text_box_count = 0
            slide_parts = sorted(
                name for name in names if name.startswith("ppt/slides/slide") and name.endswith(".xml")
            )
            layout_parts = sorted(
                name for name in names if name.startswith("ppt/slideLayouts/slideLayout") and name.endswith(".xml")
            )

            invalid_slide_layout_relationships: list[dict[str, object]] = []
            for name in slide_parts:
                relationships = [
                    relationship
                    for relationship in relationships_by_source.get(name, [])
                    if relationship["type"] == SLIDE_LAYOUT_REL_TYPE
                ]
                if len(relationships) != 1:
                    invalid_slide_layout_relationships.append(
                        {
                            "part": name,
                            "expected": 1,
                            "actual": len(relationships),
                            "targets": [relationship["resolved"] for relationship in relationships],
                        }
                    )
            if invalid_slide_layout_relationships:
                errors.append({"invalid_slide_layout_relationships": invalid_slide_layout_relationships})

            invalid_layout_master_relationships: list[dict[str, object]] = []
            for name in layout_parts:
                relationships = [
                    relationship
                    for relationship in relationships_by_source.get(name, [])
                    if relationship["type"] == SLIDE_MASTER_REL_TYPE
                ]
                if len(relationships) != 1:
                    invalid_layout_master_relationships.append(
                        {
                            "part": name,
                            "expected": 1,
                            "actual": len(relationships),
                            "targets": [relationship["resolved"] for relationship in relationships],
                        }
                    )
            if invalid_layout_master_relationships:
                errors.append({"invalid_layout_master_relationships": invalid_layout_master_relationships})

            for name in slide_parts:
                root = parsed_parts.get(name)
                if root is None:
                    continue
                slide_visible_text = "\n".join(
                    node.text or "" for node in root.iter(f"{{{DRAWING_NS}}}t")
                ).strip()
                has_visual_object = (
                    root.find(f".//{{{PRESENTATION_NS}}}pic") is not None
                    or root.find(f".//{{{PRESENTATION_NS}}}graphicFrame") is not None
                )
                if strict_visual and not slide_visible_text and not has_visual_object:
                    slides_without_visible_content.append(name)
                if "\ufffd" in slide_visible_text:
                    replacement_character_slides.append(name)
                if slide_visible_text and MARKDOWN_LITERAL_RE.search(slide_visible_text):
                    visible_markdown_literals.append({"part": name, "text": slide_visible_text[:240]})
                shape_ids = [
                    node.get("id", "") for node in root.iter(f"{{{PRESENTATION_NS}}}cNvPr") if node.get("id")
                ]
                repeated_ids = duplicate_values(shape_ids)
                if repeated_ids:
                    duplicate_shape_ids.append({"part": name, "ids": repeated_ids})

                for ext in root.iter(f"{{{DRAWING_NS}}}ext"):
                    invalid_dimensions = {
                        key: ext.get(key)
                        for key in ("cx", "cy")
                        if ext.get(key, "").lstrip("-").isdigit() and int(ext.get(key, "0")) < 0
                    }
                    if invalid_dimensions:
                        negative_extents.append(
                            {
                                "part": name,
                                "cx": ext.get("cx"),
                                "cy": ext.get("cy"),
                                "invalid": invalid_dimensions,
                            }
                        )

                for shape in root.iter(f"{{{PRESENTATION_NS}}}sp"):
                    text_body = shape.find(f"{{{PRESENTATION_NS}}}txBody")
                    if text_body is None:
                        continue
                    text_box_count += 1
                    name_node = shape.find(f".//{{{PRESENTATION_NS}}}cNvPr")
                    shape_name = name_node.get("name", "") if name_node is not None else ""
                    visible_text = "".join(
                        node.text or "" for node in text_body.iter(f"{{{DRAWING_NS}}}t")
                    ).strip()
                    body_properties = text_body.find(f"{{{DRAWING_NS}}}bodyPr")
                    if body_properties is not None and (
                        body_properties.find(f"{{{DRAWING_NS}}}normAutofit") is not None
                        or body_properties.find(f"{{{DRAWING_NS}}}spAutoFit") is not None
                    ):
                        autofit_text_box_count += 1
                    if (
                        strict_visual
                        and visible_text
                        and body_properties is not None
                        and body_properties.find(f"{{{DRAWING_NS}}}spAutoFit") is not None
                    ):
                        expanding_text_boxes.append(
                            {
                                "part": name,
                                "shape": shape_name,
                                "text": visible_text[:160],
                            }
                        )
                    if (
                        strict_visual
                        and visible_text
                        and body_properties is not None
                        and body_properties.get("vertOverflow") == "ellipsis"
                    ):
                        ellipsis_text_boxes.append(
                            {
                                "part": name,
                                "shape": shape_name,
                                "text": visible_text[:160],
                            }
                        )

                    if strict_visual:
                        for run in text_body.iter(f"{{{DRAWING_NS}}}r"):
                            run_text_node = run.find(f"{{{DRAWING_NS}}}t")
                            run_text = (run_text_node.text or "").strip() if run_text_node is not None else ""
                            if not run_text:
                                continue
                            run_properties = run.find(f"{{{DRAWING_NS}}}rPr")
                            if run_properties is None or not run_properties.get("sz"):
                                runs_without_explicit_size.append(
                                    {
                                        "part": name,
                                        "shape": shape_name,
                                        "text": run_text[:160],
                                    }
                                )
                    if visible_text and PLACEHOLDER_RE.search(visible_text):
                        placeholder_copy.append(
                            {
                                "part": name,
                                "shape": shape_name,
                                "text": visible_text[:160],
                            }
                        )
            if duplicate_shape_ids:
                errors.append({"duplicate_shape_ids": duplicate_shape_ids})
            if negative_extents:
                errors.append({"negative_shape_extents": negative_extents})
            if placeholder_copy:
                errors.append({"visible_generator_placeholder_copy": placeholder_copy})
            if expanding_text_boxes:
                errors.append(
                    {
                        "strict_visual_expanding_text_boxes": expanding_text_boxes,
                        "guidance": "Use bounded a:normAutofit instead of a:spAutoFit for generated slide text.",
                    }
                )
            if ellipsis_text_boxes:
                errors.append(
                    {
                        "strict_visual_ellipsis_text_boxes": ellipsis_text_boxes,
                        "guidance": "Use bounded a:normAutofit without vertOverflow=ellipsis; shorten copy or remap the layout when text cannot fit readably.",
                    }
                )
            if runs_without_explicit_size:
                errors.append(
                    {
                        "strict_visual_runs_without_explicit_size": runs_without_explicit_size,
                        "guidance": "Set an explicit font size on every visible generated text run.",
                    }
                )
            if slides_without_visible_content:
                errors.append({"slides_without_visible_content": slides_without_visible_content})
            if replacement_character_slides:
                errors.append({"slides_with_unicode_replacement_characters": replacement_character_slides})
            if visible_markdown_literals:
                errors.append(
                    {
                        "visible_markdown_literals": visible_markdown_literals,
                        "guidance": "Render Markdown authoring syntax before placing text on slides.",
                    }
                )

            slide_master_parts = sorted(
                name for name in names if name.startswith("ppt/slideMasters/slideMaster") and name.endswith(".xml")
            )
            missing_master_text_styles = [
                name
                for name in slide_master_parts
                if parsed_parts.get(name) is not None
                and parsed_parts[name].find(f"{{{PRESENTATION_NS}}}txStyles") is None
            ]
            if missing_master_text_styles:
                errors.append({"missing_slide_master_text_styles": missing_master_text_styles})

            incomplete_theme_fonts: list[dict[str, object]] = []
            incomplete_theme_styles: list[dict[str, object]] = []
            theme_parts = sorted(
                name for name in names if name.startswith("ppt/theme/theme") and name.endswith(".xml")
            )
            for name in theme_parts:
                root = parsed_parts.get(name)
                if root is None:
                    continue

                for font_name in ("majorFont", "minorFont"):
                    font_collection = root.find(f".//{{{DRAWING_NS}}}{font_name}")
                    missing_fonts = [
                        font_type
                        for font_type in ("latin", "ea", "cs")
                        if font_collection is None
                        or font_collection.find(f"{{{DRAWING_NS}}}{font_type}") is None
                    ]
                    if missing_fonts:
                        incomplete_theme_fonts.append(
                            {"part": name, "collection": font_name, "missing": missing_fonts}
                        )

                for style_list_name in ("fillStyleLst", "lnStyleLst", "effectStyleLst", "bgFillStyleLst"):
                    style_list = root.find(f".//{{{DRAWING_NS}}}{style_list_name}")
                    style_count = len(list(style_list)) if style_list is not None else 0
                    if style_count < 3:
                        incomplete_theme_styles.append(
                            {
                                "part": name,
                                "list": style_list_name,
                                "minimum": 3,
                                "actual": style_count,
                            }
                        )
            if incomplete_theme_fonts:
                errors.append({"incomplete_theme_font_collections": incomplete_theme_fonts})
            if incomplete_theme_styles:
                errors.append({"incomplete_theme_style_lists": incomplete_theme_styles})

            presentation = parsed_parts.get("ppt/presentation.xml")
            if presentation is None:
                errors.append("Missing ppt/presentation.xml.")
            else:
                slide_id_nodes = presentation.findall(f".//{{{PRESENTATION_NS}}}sldId")
                slide_ids = [node.get("id", "") for node in slide_id_nodes]
                slide_rel_ids = [node.get(f"{{{OFFICE_REL_NS}}}id", "") for node in slide_id_nodes]
                repeated_slide_ids = duplicate_values(slide_ids)
                repeated_slide_rel_ids = duplicate_values(slide_rel_ids)
                if repeated_slide_ids:
                    errors.append({"duplicate_presentation_slide_ids": repeated_slide_ids})
                if repeated_slide_rel_ids:
                    errors.append({"duplicate_presentation_slide_relationship_ids": repeated_slide_rel_ids})

                child_names = [child.tag.rsplit("}", 1)[-1] for child in list(presentation)]
                if "notesMasterIdLst" in child_names and "sldIdLst" in child_names:
                    notes_index = child_names.index("notesMasterIdLst")
                    slide_index = child_names.index("sldIdLst")
                    if notes_index > slide_index:
                        errors.append(
                            {
                                "presentation_child_order": {
                                    "expected": "notesMasterIdLst before sldIdLst",
                                    "actual": child_names,
                                }
                            }
                        )

            counts.update(
                {
                    "zip_entries": len(names),
                    "xml_parts": len(parsed_parts),
                    "slides": len(slide_parts),
                    "media": sum(
                        1 for name in names if name.startswith("ppt/media/") and not name.endswith("/")
                    ),
                    "directories": sum(1 for name in names if name.endswith("/")),
                    "notes": sum(
                        1
                        for name in names
                        if name.startswith("ppt/notesSlides/notesSlide") and name.endswith(".xml")
                    ),
                    "text_boxes": text_box_count,
                    "autofit_text_boxes": autofit_text_box_count,
                    "expanding_text_boxes": len(expanding_text_boxes),
                    "ellipsis_text_boxes": len(ellipsis_text_boxes),
                    "runs_without_explicit_size": len(runs_without_explicit_size),
                    "slides_without_visible_content": len(slides_without_visible_content),
                    "visible_markdown_literals": len(visible_markdown_literals),
                    "external_web_hyperlinks": len(external_web_hyperlinks),
                }
            )
            if expected_slides is not None and len(slide_parts) != expected_slides:
                errors.append({"slide_count_mismatch": {"expected": expected_slides, "actual": len(slide_parts)}})
    except (OSError, zipfile.BadZipFile) as exc:
        errors.append({"package_open_error": str(exc)})

    return {
        "pass": not errors,
        "file": str(path),
        "size": path.stat().st_size,
        "errors": errors,
        "warnings": warnings,
        "counts": counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a generated PPTX OOXML package.")
    parser.add_argument("pptx", type=Path, help="PPTX file to validate.")
    parser.add_argument("--expected-slides", type=int, help="Fail if the generated slide count differs.")
    parser.add_argument(
        "--strict-visual",
        action="store_true",
        help="Fail on generated text that can expand outside its box or inherits an unspecified font size.",
    )
    args = parser.parse_args()

    report = validate_pptx(args.pptx, args.expected_slides, args.strict_visual)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
