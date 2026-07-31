---
name: xlsx
description: Create, read, clean, normalize, analyze, validate, and edit Excel/XLSX spreadsheets, CSV-style tables, formulas, charts, budgets, reports, data summaries, and spreadsheet deliverables. Use when the user asks for Excel, XLSX, spreadsheet, workbook, table analysis, data cleaning, formulas, pivots, charts, or 表格/Excel/数据清洗/数据分析.
---

# XLSX

Work with spreadsheets as real structured data, not prose.

## Operating Rules

- Identify the goal: clean data, analyze data, create a workbook, add formulas, summarize, or prepare a report.
- Preserve user-provided rows, columns, labels, units, and assumptions.
- Use `mcp__assistant__create_file` with `format: "xlsx"` for reliable workbook output when a file is requested.
- Use `rows` for tabular output instead of embedding tables in prose.
- For multiple sheets, formulas, filters, frozen panes, conditional formatting, or charts, pass the tool's structured `workbook` object. Do not flatten an advanced workbook into one `rows` table.
- For formulas or analysis, explain assumptions and include check totals when useful.
- Build formula references from the actual output row and column coordinates. Before generation, verify that copied formulas did not shift criteria headers or data rows by one position.
- Keep display labels separate from formula criteria. A series label such as `朝阳店收入` must not be used as a `SUMIF`/`SUMIFS` criterion when the source key is `朝阳店`.
- Never create direct or indirect circular references. A formula must not reference its own cell, a range containing its own cell, or a dependency chain that returns to it.
- Do not write plain text with an `.xlsx` extension.
- Do not create external-workbook formulas, live-data formulas, linked charts, or hidden external data connections.

## Runtime Contract

- Use `mcp__assistant__python_execute` for substantial cleaning, joins, aggregation, statistics, or chart-data preparation.
- Run bundled scripts with `mcp__assistant__python_execute` using the script's actual installed Skill path and `arguments`; do not probe or modify system Python.
- Do not run `pip`, `uv`, or Conda from this Skill. Use only the managed package set.
- Keep final workbook creation in `mcp__assistant__create_file` unless a requested feature is unsupported there.
- If an unsupported advanced feature requires another approved generator, call `mcp__assistant__present_files` with every verified final workbook before replying.
- The built-in Node generator supports native column, bar, and line charts. Do not switch to a custom Python/OOXML generator merely to create a trend line.

## Bundled Resources

- Read `references/workbook-patterns.md` for multi-sheet workbooks, messy data, financial tables, reports, or reusable templates.
- Use `scripts/normalize_table.py` on pasted CSV/TSV/JSON, inconsistent rows, exported tables, or data that may contain empty rows and duplicate headers.
- Run `scripts/validate_xlsx.py --strict-visual` on every generated workbook before reporting success.
- Use `assets/workbook-templates/` when the user asks for a common workbook:
  - `project-tracker.json` for task/status tracking.
  - `budget-summary.json` for budget versus actual tables.
  - `research-matrix.json` for source/evidence tracking.
  - `assistant-acceptance.json` for the two-sheet Agent acceptance workbook with formulas, conditional formats, and a chart.
- Use `scripts/prepare_workbook_template.py` to list or prepare template rows.

## Common Workflows

- **Create workbook**: define sheet purpose, columns, sample rows, formulas, and final `.xlsx`.
- **Clean data**: normalize headers, remove empty rows, trim values, standardize dates/currencies, flag ambiguous rows.
- **Analyze data**: compute totals, averages, segments, rankings, trends, anomalies, and concise interpretation.
- **Report table**: create a summary table first, then provide insights and next actions.

For messy input:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/normalize_table.py"` and `arguments: ["raw.csv", "--out", "rows.json"]`.

Then pass the normalized `rows` to `mcp__assistant__create_file`.

For template output, load the closest JSON asset and pass its `rows` to `mcp__assistant__create_file`.

For a template, call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/prepare_workbook_template.py"` and `arguments: ["project-tracker", "--title", "Project Tracker", "--out", "workbook.json"]`.

Advanced templates contain a top-level `workbook` object. Pass that object unchanged to `mcp__assistant__create_file` together with `format: "xlsx"`, `title`, and `file_path`.

Formula cells use an explicit cached result so the workbook, previews, and charts are correct before Excel recalculates:

```json
{
  "value": 0,
  "formula": "COUNTIF('测试明细'!G2:G1000,\"通过\")",
  "result": 4,
  "style": "integer"
}
```

For an acceptance workbook, validate every requested feature:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/validate_xlsx.py"` and `arguments: ["output.xlsx", "--min-sheets", "2", "--require-formulas", "--require-chart", "--require-freeze", "--require-filter", "--require-conditional-format", "--strict-visual"]`.

## XLSX Integrity Guardrails

- A valid ZIP is not enough. Require valid workbook-to-sheet, sheet-to-drawing, and drawing-to-chart relationships.
- Require unique sheet names, relationship IDs, and cell references.
- Require formula cells to include cached results and enable normal Excel recalculation without external links.
- Require deterministic `SUMIF`/`SUMIFS` results to match their cached results. A workbook that shows values before recalculation but becomes zero after Excel opens is invalid.
- Treat direct, range-based, cross-sheet, and indirect circular formula references as blocking. Fix the workbook definition and regenerate; never rely on Excel repair to delete formulas.
- Treat external workbook references, `WEBSERVICE`, `RTD`, DDE, external chart ranges, and `xl/externalLinks` parts as blocking.
- Do not show value labels on every point of a dense chart. More than 8 categories or 12 total data points must rely on axes, legends, and the source table instead of a wall of overlapping numbers.
- Do not place period values and cumulative values with very different scales into a labeled clustered-column chart. Prefer the period trend alone, separate charts, or a supported secondary-axis combination.
- For compact charts where labels are useful, place them outside the bar/column end and verify that they do not collide with the axis, legend, or adjacent labels.
- Reject a trend chart with no numeric source data. Treat a genuine all-zero series as valid but verify it against the source and explain the no-activity result when useful; formula/cache disagreement remains blocking.
- Ordinary `http`, `https`, or `mailto` hyperlinks may be intentional; the validator reports them as warnings.
- Never report completion if `validate_xlsx.py` exits nonzero or Excel asks to repair the workbook.

## Quality Bar

- Columns should have clear names and consistent types.
- Numeric outputs should preserve units and rounding rules.
- Important assumptions should be visible.
- Output should be machine-usable and easy to inspect in Excel.
- Charts must remain readable at the default zoom: no overlapping data labels, crushed small series, long numbers floating across the plot area, or an axis that hides negative, mixed-sign, or constant values.
- The workbook must pass package validation and every requested feature check.
