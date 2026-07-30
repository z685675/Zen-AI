#!/usr/bin/env python3
"""Write a safe DOCX copy with open-time field updating disabled."""

from __future__ import annotations

import argparse
import io
import json
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from validate_docx import WORD_NS, validate_docx


def register_namespaces(xml_data: bytes) -> None:
    for _, namespace in ET.iterparse(io.BytesIO(xml_data), events=("start-ns",)):
        prefix, uri = namespace
        if prefix not in {"xml", "xmlns"}:
            ET.register_namespace(prefix or "", uri)


def error_name(error: dict[str, object] | str) -> str:
    if not isinstance(error, dict) or len(error) != 1:
        return "unknown"
    return next(iter(error))


def remove_open_time_update(xml_data: bytes) -> tuple[bytes, int]:
    register_namespaces(xml_data)
    root = ET.fromstring(xml_data)
    update_tag = f"{{{WORD_NS}}}updateFields"
    removed = 0
    for parent in root.iter():
        for child in list(parent):
            if child.tag == update_tag:
                parent.remove(child)
                removed += 1
    if not removed:
        return xml_data, 0
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), removed


def repair_docx(source: Path, output: Path) -> dict[str, object]:
    if source.resolve() == output.resolve():
        raise ValueError("Output must be a new file; the source DOCX is never overwritten.")
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")

    preflight = validate_docx(source)
    blocking = [
        error
        for error in preflight.get("errors", [])
        if error_name(error) != "open_time_field_update"
    ]
    if blocking:
        raise ValueError(
            "Source has defects that cannot be repaired safely: "
            + json.dumps(blocking, ensure_ascii=False)
        )

    with zipfile.ZipFile(source) as source_zip:
        infos = source_zip.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            raise ValueError("Source contains duplicate ZIP entries.")
        parts = {info.filename: source_zip.read(info.filename) for info in infos if not info.is_dir()}

    settings_name = "word/settings.xml"
    removed = 0
    if settings_name in parts:
        parts[settings_name], removed = remove_open_time_update(parts[settings_name])

    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output_zip:
        for info in infos:
            if info.is_dir():
                output_zip.writestr(info, b"")
            else:
                output_zip.writestr(info, parts[info.filename])

    validation = validate_docx(output)
    return {
        "success": bool(validation["pass"]),
        "source": str(source),
        "output": str(output),
        "changes": {"removed_updateFields_nodes": removed},
        "validation": validation,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Disable open-time field updates in a new DOCX copy.")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    try:
        report = repair_docx(args.source, args.output)
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
