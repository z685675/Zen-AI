# Research Report Templates

Use this reference for evidence-backed reports.

## Decision Memo

- Question
- Short answer
- Why it matters
- Evidence
- Alternatives
- Recommendation
- Risks and unknowns
- Next steps

Best for executives or product decisions.

## Competitor Analysis

- Scope and competitors
- Positioning
- Product capabilities
- Pricing or packaging
- Go-to-market signals
- Strengths and weaknesses
- Implications
- Recommended response

Avoid feature dumping; convert observations into implications.

## Market Or Industry Brief

- Market definition
- Demand drivers
- Current signals
- Key players
- Constraints and risks
- Outlook
- Opportunities

Use current sources and clearly mark estimates.

## Evidence Rules

- Build a source matrix before final synthesis when sources are numerous.
- Cite externally supported claims with direct source links. For a structured
  source inventory, IDs like `[S1]` should resolve to those links.
- Mark stale, weak, conflicting, or geography-mismatched sources.
- Keep "facts", "interpretation", and "recommendation" separate.

## Deep Research Plan

- Objective and decision to support
- Scope, timeframe, and geography
- Key research questions and investigation approach
- Source strategy and freshness requirements
- Expected deliverable
- Known uncertainties
- Confirmation request

## Deep Research Report

1. Executive summary
2. Scope and method
3. Findings by research question
4. Alternatives, feasibility and trade-offs
5. Conflicting signals and uncertainties
6. Analysis and implications
7. Recommendations, action priorities and ways to validate them
8. Sources with direct URLs
9. Limitations and remaining gaps

For current external claims, place a clickable URL beside the relevant paragraph as well as in the final source list.

## Optional source inventory validation

Use this procedure for an explicitly requested source inventory, reproducible
review or citation audit. An ordinary in-chat Deep Research report does not need
these files or a numeric gate. Choose coverage requirements from the task; do
not add sources only to reach a count.

1. Save a structured evidence list as `sources.json`, using
   `assets/report-schemas/source-matrix.json` when helpful. If a checkpoint
   already contains findings, reuse `research_state.py export-sources`.
2. Validate the existing report rather than generating another full version.
   Through `mcp__assistant__python_execute`, call:

   - `script_path`: `<skill-root>/scripts/source_matrix.py`
   - `arguments`: `["sources.json", "--out", "source-matrix.json", "--strict", "--min-sources", "<agreed-count>", "--min-domains", "<appropriate-diversity>", "--report", "report.md"]`

3. Inspect `quality_gate.passed`. Correct invalid/duplicate URLs, unsupported
   claims, missing links and unresolved source IDs. Report any remaining failure
   honestly; never claim the gate passed if it did not. Domain and source counts
   do not establish independence, truth or adequate coverage of a hard question.
4. Preserve known DOI aliases as one source and keep unread candidates outside
   verified evidence. Explain missing evidence and its effect on conclusions.
