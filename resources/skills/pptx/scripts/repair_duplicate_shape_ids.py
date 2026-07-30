#!/usr/bin/env python3
"""Write a repaired PPTX copy with common PowerPoint OOXML defects normalized."""

from __future__ import annotations

import argparse
import io
import json
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
THEME_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
THEME_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.theme+xml"


def register_namespaces(xml_data: bytes) -> None:
    for _, namespace in ET.iterparse(io.BytesIO(xml_data), events=("start-ns",)):
        prefix, uri = namespace
        if prefix not in {"xml", "xmlns"}:
            ET.register_namespace(prefix or "", uri)


def relationship_source(rels_path: str) -> str:
    if rels_path == "_rels/.rels":
        return ""
    marker = "/_rels/"
    if marker not in rels_path or not rels_path.endswith(".rels"):
        return ""
    prefix, leaf = rels_path.split(marker, 1)
    return posixpath.join(prefix, leaf[:-5])


def resolve_relationship_target(source: str, target: str) -> str:
    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    return posixpath.normpath(posixpath.join(posixpath.dirname(source), target))


def toggle_flip(xfrm: ET.Element, attribute: str) -> None:
    xfrm.set(attribute, "0" if xfrm.get(attribute) == "1" else "1")


def repair_slide(xml_data: bytes) -> tuple[bytes, list[dict[str, object]]]:
    register_namespaces(xml_data)
    root = ET.fromstring(xml_data)
    nodes = list(root.iter(f"{{{PRESENTATION_NS}}}cNvPr"))
    numeric_ids = [int(node.get("id", "0")) for node in nodes if node.get("id", "").isdigit()]
    next_id = max(numeric_ids, default=0) + 1
    seen: set[str] = set()
    changes: list[dict[str, object]] = []

    for node in nodes:
        shape_id = node.get("id", "")
        if not shape_id or shape_id not in seen:
            seen.add(shape_id)
            continue
        while str(next_id) in seen:
            next_id += 1
        replacement = str(next_id)
        node.set("id", replacement)
        seen.add(replacement)
        changes.append({"name": node.get("name", ""), "old_id": shape_id, "new_id": replacement})
        next_id += 1

    for xfrm in root.iter(f"{{{DRAWING_NS}}}xfrm"):
        off = xfrm.find(f"{{{DRAWING_NS}}}off")
        ext = xfrm.find(f"{{{DRAWING_NS}}}ext")
        if off is None or ext is None:
            continue

        for dimension, coordinate, flip in (("cx", "x", "flipH"), ("cy", "y", "flipV")):
            raw_value = ext.get(dimension, "")
            if not raw_value.lstrip("-").isdigit():
                continue
            value = int(raw_value)
            if value >= 0:
                continue
            off.set(coordinate, str(int(off.get(coordinate, "0")) + value))
            ext.set(dimension, str(-value))
            toggle_flip(xfrm, flip)
            changes.append(
                {
                    "type": "negative_extent",
                    "dimension": dimension,
                    "old_value": value,
                    "new_value": -value,
                }
            )

    if not changes:
        return xml_data, []
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), changes


def repair_presentation(xml_data: bytes) -> tuple[bytes, list[dict[str, object]]]:
    register_namespaces(xml_data)
    root = ET.fromstring(xml_data)
    children = list(root)
    notes_master = root.find(f"{{{PRESENTATION_NS}}}notesMasterIdLst")
    slide_ids = root.find(f"{{{PRESENTATION_NS}}}sldIdLst")
    if notes_master is None or slide_ids is None:
        return xml_data, []

    notes_index = children.index(notes_master)
    slide_index = children.index(slide_ids)
    if notes_index <= slide_index:
        return xml_data, []

    root.remove(notes_master)
    root.insert(slide_index, notes_master)
    return (
        ET.tostring(root, encoding="utf-8", xml_declaration=True),
        [{"type": "presentation_child_order", "moved": "notesMasterIdLst before sldIdLst"}],
    )


def clone_shared_notes_master_themes(parts: dict[str, bytes]) -> list[dict[str, object]]:
    theme_relationships: list[dict[str, str]] = []
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        root = ET.fromstring(data)
        source = relationship_source(name)
        for relationship in root.findall(f"{{{PACKAGE_REL_NS}}}Relationship"):
            if relationship.get("Type") != THEME_REL_TYPE or relationship.get("TargetMode") == "External":
                continue
            target = relationship.get("Target", "")
            theme_relationships.append(
                {
                    "part": name,
                    "source": source,
                    "id": relationship.get("Id", ""),
                    "resolved": resolve_relationship_target(source, target),
                }
            )

    used_theme_numbers = {
        int(match.group(1))
        for name in parts
        if (match := re.fullmatch(r"ppt/theme/theme(\d+)\.xml", name))
    }
    next_theme_number = max(used_theme_numbers, default=0) + 1
    cloned_themes: list[tuple[str, str]] = []
    report: list[dict[str, object]] = []

    for relationship in theme_relationships:
        if not relationship["source"].startswith("ppt/notesMasters/"):
            continue
        other_owners = {
            candidate["source"]
            for candidate in theme_relationships
            if candidate["resolved"] == relationship["resolved"]
            and candidate["source"] != relationship["source"]
        }
        if not other_owners:
            continue

        original_theme = relationship["resolved"]
        if original_theme not in parts:
            continue
        while next_theme_number in used_theme_numbers:
            next_theme_number += 1
        new_theme = f"ppt/theme/theme{next_theme_number}.xml"
        used_theme_numbers.add(next_theme_number)
        next_theme_number += 1
        parts[new_theme] = parts[original_theme]
        cloned_themes.append((original_theme, new_theme))

        rels_data = parts[relationship["part"]]
        register_namespaces(rels_data)
        rels_root = ET.fromstring(rels_data)
        target_relationship = next(
            node
            for node in rels_root.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
            if node.get("Id") == relationship["id"]
        )
        target_relationship.set(
            "Target",
            posixpath.relpath(new_theme, posixpath.dirname(relationship["source"])),
        )
        parts[relationship["part"]] = ET.tostring(
            rels_root, encoding="utf-8", xml_declaration=True
        )
        report.append(
            {
                "part": relationship["part"],
                "changes": [
                    {
                        "type": "dedicated_notes_master_theme",
                        "old_theme": original_theme,
                        "new_theme": new_theme,
                        "previously_shared_with": sorted(other_owners),
                    }
                ],
            }
        )

    if cloned_themes and "[Content_Types].xml" in parts:
        content_types_data = parts["[Content_Types].xml"]
        register_namespaces(content_types_data)
        content_types_root = ET.fromstring(content_types_data)
        overrides = content_types_root.findall(f"{{{CONTENT_TYPES_NS}}}Override")
        overrides_by_part = {node.get("PartName", ""): node for node in overrides}
        for original_theme, new_theme in cloned_themes:
            original_part_name = f"/{original_theme}"
            new_part_name = f"/{new_theme}"
            if new_part_name in overrides_by_part:
                continue
            source_override = overrides_by_part.get(original_part_name)
            content_type = (
                source_override.get("ContentType", THEME_CONTENT_TYPE)
                if source_override is not None
                else THEME_CONTENT_TYPE
            )
            ET.SubElement(
                content_types_root,
                f"{{{CONTENT_TYPES_NS}}}Override",
                {"PartName": new_part_name, "ContentType": content_type},
            )
        parts["[Content_Types].xml"] = ET.tostring(
            content_types_root, encoding="utf-8", xml_declaration=True
        )

    return report


def repair_pptx(source: Path, output: Path) -> list[dict[str, object]]:
    if source.resolve() == output.resolve():
        raise ValueError("Output must be a new file; the source PPTX is never overwritten.")
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")

    report: list[dict[str, object]] = []
    with zipfile.ZipFile(source) as source_zip:
        parts = {
            info.filename: source_zip.read(info.filename)
            for info in source_zip.infolist()
            if not info.is_dir()
        }

    for name in list(parts):
        data = parts[name]
        if name.startswith("ppt/slides/slide") and name.endswith(".xml"):
            data, changes = repair_slide(data)
            if changes:
                report.append({"part": name, "changes": changes})
        elif name == "ppt/presentation.xml":
            data, changes = repair_presentation(data)
            if changes:
                report.append({"part": name, "changes": changes})
        parts[name] = data

    report.extend(clone_shared_notes_master_themes(parts))

    with zipfile.ZipFile(
        output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6
    ) as output_zip:
        for name, data in parts.items():
            output_zip.writestr(name, data)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Repair common PowerPoint OOXML defects into a new PPTX copy.")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    try:
        changes = repair_pptx(args.source, args.output)
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(
        json.dumps(
            {"success": True, "source": str(args.source), "output": str(args.output), "changes": changes},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
