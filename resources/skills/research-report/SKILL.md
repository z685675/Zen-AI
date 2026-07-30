---
name: research-report
description: Conduct structured research and produce cited, decision-oriented reports, industry analysis, competitor analysis, market research, product research, policy summaries, academic briefings, and executive research memos. Use when the user asks for 深度研究, 调研报告, 行业分析, 竞品分析, research report, market research, evidence-backed analysis, report with sources, or current sourced analysis.
---

# Research Report

Produce research that separates evidence, interpretation, and recommendation.

## Operating Rules

- Clarify or infer the research question, scope, geography, timeframe, and intended decision.
- Use current sources when the topic may have changed recently.
- Cite sources for claims that depend on external facts.
- Distinguish facts, estimates, assumptions, and opinions.
- Prefer concise executive synthesis over raw source dumping.
- Use `mcp__assistant__python_execute` for bundled scripts and structured analysis. Do not probe or modify system Python.

## Bundled Resources

- Read `references/report-templates.md` for decision memos, competitor analysis, market briefs, and evidence rules.
- Use `scripts/source_matrix.py` when collecting multiple URLs/sources or when the report needs traceable evidence.
- Use `assets/report-schemas/source-matrix.json` when the report needs a reusable evidence schema for findings, source IDs, confidence, and uncertainty.

## Report Structure

Use this structure by default:

1. Executive summary
2. Key findings
3. Evidence and source notes
4. Analysis
5. Risks, uncertainties, and opposing signals
6. Recommendations or next steps

For competitor research, add:

- Positioning
- Product capabilities
- Pricing or packaging
- Go-to-market signals
- Strengths, weaknesses, and implications

For source-heavy work:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/source_matrix.py"` and `arguments: ["sources.md", "--out", "source-matrix.json"]`.

## Quality Bar

- Every major conclusion should be supported by evidence.
- Do not overstate certainty.
- Call out outdated, weak, or conflicting sources.
- Make the final recommendation actionable.
- If the user asks for a file, follow the complete `$docx` or `$pdf` workflow and require that format's final validator to pass. Do not treat the research draft alone as a delivered file.
