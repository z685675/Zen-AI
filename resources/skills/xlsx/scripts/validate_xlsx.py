#!/usr/bin/env python3
"""Validate XLSX package integrity, formulas, links, and requested workbook features."""

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
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CHART_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
REL_TYPE_HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
REQUIRED_PARTS = {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
RISKY_FORMULA_RE = re.compile(r"\[[^\]]*\]|(?:https?|file)://|\\\\|\b(?:WEBSERVICE|RTD|DDE)\s*\(", re.I)
CELL_REF_RE = re.compile(r"^[A-Z]{1,3}[1-9]\d*$")
FORMULA_RANGE_REF_RE = re.compile(
    r"(?:(?:'((?:[^']|'')+)'|([\w.]+))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)\s*:\s*\$?([A-Z]{1,3})\$?([1-9]\d*)",
    re.I,
)
FORMULA_CELL_REF_RE = re.compile(
    r"(?:(?:'((?:[^']|'')+)'|([\w.]+))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)",
    re.I,
)
SIMPLE_FORMULA_RANGE_RE = re.compile(
    r"^(?:(?:'((?:[^']|'')+)'|([\w.]+))!)?\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)$",
    re.I,
)
SIMPLE_FORMULA_CELL_RE = re.compile(
    r"^(?:(?:'((?:[^']|'')+)'|([\w.]+))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)$",
    re.I,
)
SIMPLE_SUM_FORMULA_RE = re.compile(r"^\s*(SUMIFS|SUMIF)\((.*)\)\s*$", re.I)


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


def column_number(value: str) -> int:
    total = 0
    for character in value.upper():
        total = total * 26 + ord(character) - 64
    return total


def formula_cell_key(sheet: str, cell: str) -> tuple[str, str]:
    return sheet.casefold(), cell.upper()


def find_circular_formulas(formulas: list[dict[str, object]]) -> list[list[str]]:
    formula_cells: dict[tuple[str, str], dict[str, object]] = {
        formula_cell_key(str(item["sheet"]), str(item["cell"])): item
        for item in formulas
        if item.get("sheet") and item.get("cell")
    }
    coordinates: dict[tuple[str, str], tuple[int, int]] = {}
    for key in formula_cells:
        match = re.match(r"^([A-Z]{1,3})([1-9]\d*)$", key[1])
        if match:
            coordinates[key] = (column_number(match.group(1)), int(match.group(2)))

    graph: dict[tuple[str, str], set[tuple[str, str]]] = {key: set() for key in formula_cells}
    for key, item in formula_cells.items():
        current_sheet = str(item["sheet"])
        formula = re.sub(r'"(?:[^"]|"")*"', "", str(item.get("formula") or ""))

        for match in FORMULA_RANGE_REF_RE.finditer(formula):
            sheet = (match.group(1) or match.group(2) or current_sheet).replace("''", "'")
            start_column, start_row = column_number(match.group(3)), int(match.group(4))
            end_column, end_row = column_number(match.group(5)), int(match.group(6))
            min_column, max_column = sorted((start_column, end_column))
            min_row, max_row = sorted((start_row, end_row))
            normalized_sheet = sheet.casefold()

            for candidate, (column, row) in coordinates.items():
                if (
                    candidate[0] == normalized_sheet
                    and min_column <= column <= max_column
                    and min_row <= row <= max_row
                ):
                    graph[key].add(candidate)

        formula_without_ranges = FORMULA_RANGE_REF_RE.sub("", formula)
        for match in FORMULA_CELL_REF_RE.finditer(formula_without_ranges):
            sheet = (match.group(1) or match.group(2) or current_sheet).replace("''", "'")
            candidate = formula_cell_key(sheet, f"{match.group(3)}{match.group(4)}")
            if candidate in formula_cells:
                graph[key].add(candidate)

    state: dict[tuple[str, str], str] = {}
    stack: list[tuple[str, str]] = []

    def visit(key: tuple[str, str]) -> list[tuple[str, str]] | None:
        if state.get(key) == "visited":
            return None
        if state.get(key) == "visiting":
            start = stack.index(key)
            return [*stack[start:], key]

        state[key] = "visiting"
        stack.append(key)
        for dependency in graph.get(key, set()):
            cycle = visit(dependency)
            if cycle:
                return cycle
        stack.pop()
        state[key] = "visited"
        return None

    for key in formula_cells:
        cycle = visit(key)
        if cycle:
            return [
                [f"'{formula_cells[item]['sheet']}'!{formula_cells[item]['cell']}" for item in cycle]
            ]
    return []


def split_formula_arguments(value: str) -> list[str]:
    arguments: list[str] = []
    start = 0
    in_string = False
    in_sheet_name = False
    index = 0
    while index < len(value):
        character = value[index]
        if character == '"' and not in_sheet_name:
            if in_string and index + 1 < len(value) and value[index + 1] == '"':
                index += 1
            else:
                in_string = not in_string
        elif character == "'" and not in_string:
            if in_sheet_name and index + 1 < len(value) and value[index + 1] == "'":
                index += 1
            else:
                in_sheet_name = not in_sheet_name
        elif character == "," and not in_string and not in_sheet_name:
            arguments.append(value[start:index].strip())
            start = index + 1
        index += 1
    arguments.append(value[start:].strip())
    return arguments


def resolve_formula_range_values(
    reference: str,
    current_sheet: str,
    cell_values: dict[tuple[str, str], object],
) -> list[object] | None:
    match = SIMPLE_FORMULA_RANGE_RE.fullmatch(reference)
    if not match:
        return None
    sheet = (match.group(1) or match.group(2) or current_sheet).replace("''", "'").casefold()
    start_column, start_row = column_number(match.group(3)), int(match.group(4))
    end_column, end_row = column_number(match.group(5)), int(match.group(6))
    values: list[object] = []
    for row in range(min(start_row, end_row), max(start_row, end_row) + 1):
        for column in range(min(start_column, end_column), max(start_column, end_column) + 1):
            values.append(cell_values.get((sheet, f"{column_name(column)}{row}")))
    return values


def resolve_formula_criterion(
    reference: str,
    current_sheet: str,
    cell_values: dict[tuple[str, str], object],
) -> object:
    match = SIMPLE_FORMULA_CELL_RE.fullmatch(reference)
    if match:
        sheet = (match.group(1) or match.group(2) or current_sheet).replace("''", "'").casefold()
        return cell_values.get((sheet, f"{match.group(3).upper()}{match.group(4)}"))
    if re.fullmatch(r'"(?:[^"]|"")*"', reference):
        return reference[1:-1].replace('""', '"')
    try:
        return float(reference)
    except ValueError:
        return None


def formula_values_equal(left: object, right: object) -> bool:
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return abs(float(left) - float(right)) <= 1e-10
    return str(left or "").casefold() == str(right or "").casefold()


def evaluate_simple_sum_formula(
    formula: str,
    current_sheet: str,
    cell_values: dict[tuple[str, str], object],
) -> float | None:
    match = SIMPLE_SUM_FORMULA_RE.fullmatch(formula)
    if not match or "(" in match.group(2) or ")" in match.group(2):
        return None
    arguments = split_formula_arguments(match.group(2))
    function_name = match.group(1).upper()

    if function_name == "SUMIFS":
        if len(arguments) < 3 or len(arguments) % 2 == 0:
            return None
        sum_values = resolve_formula_range_values(arguments[0], current_sheet, cell_values)
        if sum_values is None:
            return None
        criteria: list[tuple[list[object], object]] = []
        for index in range(1, len(arguments), 2):
            values = resolve_formula_range_values(arguments[index], current_sheet, cell_values)
            expected = resolve_formula_criterion(arguments[index + 1], current_sheet, cell_values)
            if values is None or expected is None or len(values) != len(sum_values):
                return None
            criteria.append((values, expected))
        total = 0.0
        for index, value in enumerate(sum_values):
            if all(formula_values_equal(values[index], expected) for values, expected in criteria):
                try:
                    total += float(value or 0)
                except (TypeError, ValueError):
                    continue
        return total

    if len(arguments) not in {2, 3}:
        return None
    criteria_values = resolve_formula_range_values(arguments[0], current_sheet, cell_values)
    expected = resolve_formula_criterion(arguments[1], current_sheet, cell_values)
    sum_values = resolve_formula_range_values(arguments[2] if len(arguments) == 3 else arguments[0], current_sheet, cell_values)
    if criteria_values is None or expected is None or sum_values is None or len(criteria_values) != len(sum_values):
        return None
    total = 0.0
    for index, value in enumerate(sum_values):
        if formula_values_equal(criteria_values[index], expected):
            try:
                total += float(value or 0)
            except (TypeError, ValueError):
                continue
    return total


def find_formula_cache_mismatches(
    formulas: list[dict[str, object]],
    cell_values: dict[tuple[str, str], object],
) -> list[dict[str, object]]:
    mismatches: list[dict[str, object]] = []
    for item in formulas:
        cached = item.get("result")
        if not isinstance(cached, (int, float)):
            continue
        evaluated = evaluate_simple_sum_formula(str(item.get("formula") or ""), str(item.get("sheet") or ""), cell_values)
        if evaluated is None:
            continue
        tolerance = max(1e-8, abs(evaluated) * 1e-9)
        if abs(evaluated - float(cached)) <= tolerance:
            continue
        mismatches.append(
            {
                "sheet": item.get("sheet"),
                "cell": item.get("cell"),
                "formula": item.get("formula"),
                "cached": cached,
                "evaluated": evaluated,
            }
        )
        if len(mismatches) >= 100:
            break
    return mismatches


def column_name(value: int) -> str:
    result = ""
    while value > 0:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def parse_cell_value(cell: ET.Element, shared_strings: list[str]) -> object:
    cell_type = cell.get("t", "")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(f".//{{{SHEET_NS}}}t"))
    value_node = cell.find(f"{{{SHEET_NS}}}v")
    if value_node is None or value_node.text is None:
        return None
    value = value_node.text
    if cell_type == "s" and value.isdigit():
        index = int(value)
        return shared_strings[index] if index < len(shared_strings) else None
    if cell_type in {"str", "e"}:
        return value
    if cell_type == "b":
        return value == "1"
    try:
        numeric = float(value)
        return int(numeric) if numeric.is_integer() else numeric
    except ValueError:
        return value


def validate_xlsx(path: Path, requirements: dict[str, int | bool]) -> dict[str, object]:
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

            shared_strings: list[str] = []
            shared_strings_root = parsed_parts.get("xl/sharedStrings.xml")
            if shared_strings_root is not None:
                shared_strings = [
                    "".join(node.text or "" for node in item.findall(f".//{{{SHEET_NS}}}t"))
                    for item in shared_strings_root.findall(f"{{{SHEET_NS}}}si")
                ]

            relationship_maps: dict[str, dict[str, tuple[str, ET.Element]]] = {}
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
                relationship_maps[source] = {}
                for relationship in relationships:
                    relationship_id = relationship.get("Id", "")
                    target = relationship.get("Target", "")
                    if relationship.get("TargetMode", "").lower() == "external":
                        item = {
                            "part": name,
                            "id": relationship_id,
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
                    relationship_maps[source][relationship_id] = (resolved, relationship)
                    if resolved not in name_set:
                        missing_targets.append(
                            {"part": name, "id": relationship_id or None, "target": target, "resolved": resolved}
                        )
            if duplicate_relationship_ids:
                errors.append({"duplicate_relationship_ids": duplicate_relationship_ids})
            if missing_targets:
                errors.append({"missing_relationship_targets": missing_targets})
            if unsafe_external_relationships:
                errors.append({"unsafe_external_relationships": unsafe_external_relationships})
            if web_hyperlinks:
                warnings.append({"external_web_hyperlinks": web_hyperlinks})

            external_parts = sorted(name for name in names if name.startswith("xl/externalLinks/"))
            if external_parts:
                errors.append({"external_link_parts": external_parts})

            workbook = parsed_parts.get("xl/workbook.xml")
            sheet_parts: list[tuple[str, str]] = []
            if workbook is None:
                errors.append("Missing or invalid xl/workbook.xml.")
            else:
                sheet_nodes = workbook.findall(f".//{{{SHEET_NS}}}sheet")
                names_in_workbook = [node.get("name", "") for node in sheet_nodes]
                repeated_sheet_names = duplicate_values([name.lower() for name in names_in_workbook])
                if repeated_sheet_names:
                    errors.append({"duplicate_worksheet_names": repeated_sheet_names})
                workbook_relationships = relationship_maps.get("xl/workbook.xml", {})
                for node in sheet_nodes:
                    rel_id = node.get(f"{{{OFFICE_REL_NS}}}id", "")
                    relationship = workbook_relationships.get(rel_id)
                    if relationship is None:
                        errors.append({"missing_worksheet_relationship": {"sheet": node.get("name"), "id": rel_id}})
                        continue
                    sheet_parts.append((node.get("name", ""), relationship[0]))

                risky_defined_names = []
                for defined_name in workbook.findall(f".//{{{SHEET_NS}}}definedName"):
                    value = defined_name.text or ""
                    if RISKY_FORMULA_RE.search(value):
                        risky_defined_names.append({"name": defined_name.get("name"), "value": value})
                if risky_defined_names:
                    errors.append({"risky_defined_names": risky_defined_names})

            styles = parsed_parts.get("xl/styles.xml")
            style_count = 0
            if styles is not None:
                cell_xfs = styles.find(f"{{{SHEET_NS}}}cellXfs")
                style_count = len(list(cell_xfs)) if cell_xfs is not None else 0

            formulas: list[dict[str, object]] = []
            cell_values: dict[tuple[str, str], object] = {}
            missing_formula_cache: list[dict[str, str | None]] = []
            risky_formula_list: list[dict[str, str | None]] = []
            duplicate_cell_refs: list[dict[str, object]] = []
            invalid_style_refs: list[dict[str, str | None]] = []
            frozen_sheets = 0
            filtered_sheets = 0
            conditional_format_count = 0
            drawing_sheets = 0
            row_count = 0
            cell_count = 0

            for sheet_name, part_name in sheet_parts:
                root = parsed_parts.get(part_name)
                if root is None:
                    errors.append({"missing_worksheet_part": {"sheet": sheet_name, "part": part_name}})
                    continue
                cells = root.findall(f".//{{{SHEET_NS}}}c")
                refs = [cell.get("r", "") for cell in cells]
                repeated_refs = duplicate_values(refs)
                if repeated_refs:
                    duplicate_cell_refs.append({"sheet": sheet_name, "refs": repeated_refs})
                for cell in cells:
                    ref = cell.get("r", "")
                    parsed_value = parse_cell_value(cell, shared_strings)
                    if ref:
                        cell_values[formula_cell_key(sheet_name, ref)] = parsed_value
                    if ref and not CELL_REF_RE.match(ref):
                        errors.append({"invalid_cell_reference": {"sheet": sheet_name, "ref": ref}})
                    style = cell.get("s")
                    if style is not None and (not style.isdigit() or int(style) >= style_count):
                        invalid_style_refs.append({"sheet": sheet_name, "cell": ref or None, "style": style})
                    formula = cell.find(f"{{{SHEET_NS}}}f")
                    if formula is None:
                        continue
                    value = formula.text or ""
                    item = {
                        "sheet": sheet_name,
                        "cell": ref or None,
                        "formula": value,
                        "result": parsed_value,
                    }
                    formulas.append(item)
                    if cell.find(f"{{{SHEET_NS}}}v") is None:
                        missing_formula_cache.append({"sheet": sheet_name, "cell": ref or None})
                    if RISKY_FORMULA_RE.search(value):
                        risky_formula_list.append(item)

                pane = root.find(f".//{{{SHEET_NS}}}pane")
                if pane is not None and pane.get("state") == "frozen":
                    frozen_sheets += 1
                if root.find(f"{{{SHEET_NS}}}autoFilter") is not None:
                    filtered_sheets += 1
                conditional_format_count += len(root.findall(f"{{{SHEET_NS}}}conditionalFormatting"))
                if root.find(f"{{{SHEET_NS}}}drawing") is not None:
                    drawing_sheets += 1
                row_count += len(root.findall(f".//{{{SHEET_NS}}}row"))
                cell_count += len(cells)

            if duplicate_cell_refs:
                errors.append({"duplicate_cell_references": duplicate_cell_refs})
            if invalid_style_refs:
                errors.append({"invalid_cell_style_references": invalid_style_refs})
            if missing_formula_cache:
                errors.append({"formula_cells_without_cached_results": missing_formula_cache})
            if risky_formula_list:
                errors.append({"external_or_live_data_formulas": risky_formula_list})
            circular_formulas = find_circular_formulas(formulas)
            if circular_formulas:
                errors.append({"circular_formula_references": circular_formulas})
            formula_cache_mismatches = find_formula_cache_mismatches(formulas, cell_values)
            if formula_cache_mismatches:
                errors.append(
                    {
                        "formula_cached_result_mismatches": formula_cache_mismatches,
                        "guidance": "Regenerate formula results. SUMIF/SUMIFS criteria must match source keys exactly.",
                    }
                )

            chart_parts = sorted(name for name in names if name.startswith("xl/charts/chart") and name.endswith(".xml"))
            empty_charts: list[str] = []
            risky_chart_ranges: list[dict[str, str]] = []
            dense_chart_data_labels: list[dict[str, object]] = []
            mixed_scale_clustered_charts: list[dict[str, object]] = []
            empty_line_charts: list[dict[str, object]] = []
            all_zero_line_charts: list[dict[str, object]] = []
            labeled_chart_count = 0
            for chart_part in chart_parts:
                chart = parsed_parts.get(chart_part)
                if chart is None:
                    continue
                series_nodes = chart.findall(f".//{{{CHART_NS}}}ser")
                if not series_nodes:
                    empty_charts.append(chart_part)
                series_point_counts: list[int] = []
                series_maxima: list[float] = []
                chart_numeric_values: list[float] = []
                for series in series_nodes:
                    values = series.find(f"{{{CHART_NS}}}val")
                    if values is None:
                        series_point_counts.append(0)
                        continue
                    count_node = values.find(f".//{{{CHART_NS}}}ptCount")
                    if count_node is not None and str(count_node.get("val", "")).isdigit():
                        series_point_counts.append(int(count_node.get("val", "0")))
                    else:
                        series_point_counts.append(len(values.findall(f".//{{{CHART_NS}}}pt")))
                    numeric_values: list[float] = []
                    for value_node in values.findall(f".//{{{CHART_NS}}}pt/{{{CHART_NS}}}v"):
                        try:
                            numeric_values.append(abs(float(value_node.text or "0")))
                        except ValueError:
                            continue
                    if numeric_values:
                        series_maxima.append(max(numeric_values))
                        chart_numeric_values.extend(numeric_values)

                if requirements.get("strict_visual") and chart.find(f".//{{{CHART_NS}}}lineChart") is not None:
                    if not chart_numeric_values:
                        empty_line_charts.append(
                            {
                                "part": chart_part,
                                "series": len(series_nodes),
                                "points": sum(series_point_counts),
                            }
                        )
                    elif all(value == 0 for value in chart_numeric_values):
                        all_zero_line_charts.append(
                            {
                                "part": chart_part,
                                "series": len(series_nodes),
                                "points": sum(series_point_counts),
                            }
                        )

                positive_maxima = [value for value in series_maxima if value > 0]
                bar_chart = chart.find(f".//{{{CHART_NS}}}barChart")
                grouping = bar_chart.find(f"{{{CHART_NS}}}grouping") if bar_chart is not None else None
                if (
                    requirements.get("strict_visual")
                    and len(positive_maxima) >= 2
                    and grouping is not None
                    and grouping.get("val") == "clustered"
                ):
                    scale_ratio = max(positive_maxima) / min(positive_maxima)
                    if scale_ratio >= 8:
                        mixed_scale_clustered_charts.append(
                            {
                                "part": chart_part,
                                "series": len(series_nodes),
                                "scale_ratio": round(scale_ratio, 2),
                            }
                        )
                value_labels = any(
                    show_value.get("val", "1").lower() in {"1", "true"}
                    for labels in chart.findall(f".//{{{CHART_NS}}}dLbls")
                    for show_value in labels.findall(f"{{{CHART_NS}}}showVal")
                )
                if value_labels:
                    labeled_chart_count += 1
                    total_points = sum(series_point_counts)
                    max_categories = max(series_point_counts, default=0)
                    if requirements.get("strict_visual") and (max_categories > 8 or total_points > 12):
                        dense_chart_data_labels.append(
                            {
                                "part": chart_part,
                                "series": len(series_nodes),
                                "max_categories": max_categories,
                                "total_points": total_points,
                            }
                        )
                for formula_node in chart.findall(f".//{{{CHART_NS}}}f"):
                    value = formula_node.text or ""
                    if RISKY_FORMULA_RE.search(value):
                        risky_chart_ranges.append({"part": chart_part, "formula": value})
            if empty_charts:
                errors.append({"charts_without_series": empty_charts})
            if risky_chart_ranges:
                errors.append({"external_chart_ranges": risky_chart_ranges})
            if dense_chart_data_labels:
                errors.append(
                    {
                        "dense_chart_data_labels": dense_chart_data_labels,
                        "guidance": "Hide value labels on charts with more than 8 categories or 12 total points.",
                    }
                )
            if mixed_scale_clustered_charts:
                errors.append(
                    {
                        "mixed_scale_clustered_charts": mixed_scale_clustered_charts,
                        "guidance": "Split series whose maxima differ by 8x or more instead of clustering them on one value axis.",
                    }
                )
            if empty_line_charts:
                errors.append(
                    {
                        "empty_line_charts": empty_line_charts,
                        "guidance": "A trend chart must contain numeric source data.",
                    }
                )
            if all_zero_line_charts:
                warnings.append(
                    {
                        "all_zero_line_charts": all_zero_line_charts,
                        "guidance": "Confirm that zero is the real source value and explain the no-activity result when it matters.",
                    }
                )

            min_sheets = int(requirements.get("min_sheets", 0))
            if min_sheets and len(sheet_parts) < min_sheets:
                errors.append({"worksheet_count_below_requirement": {"required": min_sheets, "actual": len(sheet_parts)}})
            feature_requirements = {
                "require_formulas": (len(formulas), "formula"),
                "require_chart": (len(chart_parts), "chart"),
                "require_freeze": (frozen_sheets, "frozen worksheet"),
                "require_filter": (filtered_sheets, "worksheet filter"),
                "require_conditional_format": (conditional_format_count, "conditional format"),
            }
            for key, (actual, label) in feature_requirements.items():
                if requirements.get(key) and actual == 0:
                    errors.append({"missing_required_feature": label})

            counts.update(
                {
                    "zip_entries": len(names),
                    "xml_parts": len(parsed_parts),
                    "worksheets": len(sheet_parts),
                    "rows": row_count,
                    "cells": cell_count,
                    "formulas": len(formulas),
                    "charts": len(chart_parts),
                    "charts_with_value_labels": labeled_chart_count,
                    "drawings": drawing_sheets,
                    "frozen_worksheets": frozen_sheets,
                    "filtered_worksheets": filtered_sheets,
                    "conditional_formats": conditional_format_count,
                    "styles": style_count,
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
        "counts": counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a generated XLSX OOXML package.")
    parser.add_argument("xlsx", type=Path)
    parser.add_argument("--min-sheets", type=int, default=0)
    parser.add_argument("--require-formulas", action="store_true")
    parser.add_argument("--require-chart", action="store_true")
    parser.add_argument("--require-freeze", action="store_true")
    parser.add_argument("--require-filter", action="store_true")
    parser.add_argument("--require-conditional-format", action="store_true")
    parser.add_argument(
        "--strict-visual",
        action="store_true",
        help="Fail when dense charts display value labels that are likely to overlap.",
    )
    args = parser.parse_args()
    requirements = {
        "min_sheets": args.min_sheets,
        "require_formulas": args.require_formulas,
        "require_chart": args.require_chart,
        "require_freeze": args.require_freeze,
        "require_filter": args.require_filter,
        "require_conditional_format": args.require_conditional_format,
        "strict_visual": args.strict_visual,
    }
    report = validate_xlsx(args.xlsx, requirements)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
