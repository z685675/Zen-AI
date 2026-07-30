# DOCX Document Patterns

Use this reference for professional Word documents.

## Business Report

Sections:
- Executive summary
- Context and objective
- Key findings
- Analysis
- Recommendations
- Risks and dependencies
- Next steps

Use tables for findings, risks, timelines, ownership, and comparison.

## Proposal

Sections:
- Situation
- Objectives
- Scope
- Approach
- Timeline
- Deliverables
- Resources or pricing
- Risks
- Decision needed

Make the ask visible in the first page.

## Product Or Project Plan

Sections:
- Problem
- Target users
- Goals and non-goals
- Requirements
- Workflow
- Milestones
- Acceptance criteria
- Open questions

Use requirement tables when the user expects execution.

## Preflight

- Headings alone should tell the story.
- Paragraphs should be short enough to skim.
- Tables should make responsibility, dates, and decisions unambiguous.
- Run `scripts/check_document_structure.py` on long drafts before generating DOCX.
- Embed assets instead of linking local files, network shares, or templates.
- Do not enable `w:updateFields` for delivered files; it can trigger Word's generic external-field warning.
- Use a cached dynamic TOC only after Word has updated it once. Without Word, use a static contents section.
- Reject external data fields such as `LINK`, `INCLUDETEXT`, `INCLUDEPICTURE`, `DDE`, `DATABASE`, and `RD` unless explicitly requested.
- Run `scripts/validate_docx.py` on the final DOCX and require a passing result.
