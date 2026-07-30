# Workbook Patterns

Use this reference for spreadsheet deliverables that need to be usable in Excel.

## Workbook Shapes

- Raw data sheet: preserve imported rows and original labels.
- Clean data sheet: normalized headers, consistent types, no empty rows.
- Summary sheet: key totals, rankings, segments, and anomalies.
- Assumptions sheet: currencies, date ranges, filters, exclusions, and caveats.

## Quality Rules

- Keep one concept per column.
- Do not mix numbers and units in the same value when analysis is required.
- Make headers human-readable and unique.
- Use check totals when cleaning or aggregating important data.
- Preserve original data when the user may need auditability.
- Use the structured `workbook.sheets` contract for multi-sheet output; do not simulate sheets with section rows.
- Store formulas as formula cells with explicit cached results.
- Keep source keys (`朝阳店`) distinct from presentation labels (`朝阳店收入`), and make aggregate criteria reference the source key.
- Use frozen panes, filters, conditional formats, and charts only when they support the workflow.

## Chart Safety

- Use the source table for exact values and the chart for comparison or trend; do not label every point by default.
- Full value labels are appropriate only for compact charts with at most 8 categories and 12 total points.
- Avoid plotting periodic and cumulative measures as labeled clustered columns because their scales diverge over time.
- When a secondary-axis combo chart is unavailable, show the periodic trend alone or create separate charts.
- Keep legends outside the plot area and ensure labels do not collide with axes or neighboring marks at the default Excel zoom.
- Use a native line chart for time-series trends. The stable generator supports it, so a custom package generator is unnecessary.
- Give trend data a padded value axis near its actual range, including negative, mixed-sign, and constant series. Allow genuine all-zero data with a clear no-activity interpretation, but reject formula/cache disagreement that only appears as zero after recalculation.

## Useful Checks

- Are dates in one format?
- Are currencies and percentages consistent?
- Do totals reconcile with source rows?
- Do `SUMIF`/`SUMIFS` cached results equal a deterministic recalculation from the source keys?
- Are blank rows or merged-cell artifacts removed?
- Are ambiguous values flagged rather than silently changed?

Run `scripts/normalize_table.py` on pasted or messy tabular data before creating XLSX.

## Package Safety

- Do not use external workbook references, external data connections, DDE, `WEBSERVICE`, or `RTD`.
- Charts must use embedded cached data and optional internal worksheet ranges only.
- Run `scripts/validate_xlsx.py` after generation and require requested feature flags.
