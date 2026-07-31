---
name: docx
description: Create, edit, structure, validate, and polish Word/DOCX documents including reports, proposals, contracts, memos, meeting minutes, product plans, formal letters, and long-form business documents. Use when the user asks for Word, DOCX, document, report, proposal, memo, contract draft, 正式文档, Word文档, 报告, 方案, or 文档排版.
---

# DOCX

Create professional documents with clear structure, readable formatting, and a real `.docx` deliverable when requested.

## Operating Rules

- Determine the document type, audience, tone, and required sections.
- Use headings, short paragraphs, tables, and lists intentionally.
- Use `mcp__assistant__create_file` with `format: "docx"` for the first verified file output.
- Treat Markdown as an internal authoring format only. Convert headings, emphasis, links, lists, quotes, code blocks, and pipe tables into native Word structures; never expose `#`, `**`, table separators, or fenced-code markers in the finished document unless the user explicitly asks to quote Markdown source.
- Preserve every cited URL in the `content` passed to `create_file` using Markdown link syntax such as `[Source title](https://example.com/page)`. Source lists must become visible native Word hyperlinks; never pass only a source title when its URL is known.
- Pass `rows` only for a separate structured table the user requested. Do not copy the full document content into `rows`; this duplicates the document as a one-column source table.
- Do not write plain text with a `.docx` extension.
- Never ship a DOCX with open-time field updating enabled. In `docx`, do not use `features: { updateFields: true }`.
- For a real local image, pass it in `assets` as `{ id, file_path, alt_text }` and place `![descriptive alt text](asset:id)` on its own paragraph in `content`. Require `embedded-media` in the verification result; unsupported or ordinary external image URLs remain text and must not be described as embedded. Reject linked templates, linked files, external OLE objects, and external field codes unless the user explicitly requires them.
- Use `render_validation: "required"` for brand-sensitive, image-bearing, legal, or presentation-ready Word deliverables. Use `auto` for routine documents and report `render_verification: unavailable` honestly when no Office renderer is installed.
- If exact tracked changes, comments, legal formatting, or brand templates are required and the built-in generator is not enough, create a clean draft first and explain the limitation.

## Shared Visual Style System

- The user does not need to name this Skill or remember a style. Pass a specific `document_type` and let `create_file` infer `visual_style` from the title, audience, and content.
- Shared styles include `executive`, `corporate`, `consulting`, `finance`, `government`, `legal`, `academic`, `research`, `technology`, `product`, `data`, `startup`, `sales`, `brand`, `editorial`, `education`, `children`, `training`, `healthcare`, `sustainability`, `culture`, `warm`, `premium`, `creative`, `bold`, `minimal-light`, `minimal-dark`, `monochrome`, and `custom-brand`.
- Use an explicit `visual_style` only when the user requests a visual direction. Use `brand_theme` only for supplied brand colors. Use `style_mode: "print"` for grayscale print-first delivery.
- DOCX remains light, editable, and print-friendly even when the matching PPT/PDF style is dark. The style is expressed through native Word title and heading levels, typography, spacing, heading rules, quote treatment, code shading, table headers, and borders rather than a dark page background.
- Match document archetype to structure: a legal agreement should not look like a children's guide, an academic paper should not look like a sales brochure, and a warm community handbook should not inherit a generic corporate-blue treatment.

## Runtime Contract

- Run bundled scripts with `mcp__assistant__python_execute` using the script's actual installed Skill path and `arguments`; do not probe `python3`, `py`, Conda, or system Python.
- Do not install packages from this Skill. Use `mcp__assistant__create_file` for normal DOCX creation and managed Python only for bundled checks or genuinely advanced processing.
- If an advanced workflow produces the final DOCX outside `mcp__assistant__create_file`, call `mcp__assistant__present_files` with the verified final path before replying so Zen AI can show a quick-open card.

## Bundled Resources

- Read `references/document-patterns.md` for reports, proposals, product plans, project plans, and long-form business documents.
- Use `scripts/check_document_structure.py` on long drafts before creating DOCX or when the user asks for a professional document.
- Run `scripts/validate_docx.py` on every generated `.docx` before reporting success.
- Use `scripts/repair_docx.py` only to write a new safe copy after dynamic fields already have cached results.
- Use `assets/document-templates/` as starting drafts for common document types:
  - `business-report.md`
  - `proposal.md`
  - `product-plan.md`

## Document Patterns

- **Business report**: executive summary, background, findings, analysis, recommendations, next steps.
- **Proposal**: context, objectives, scope, approach, timeline, deliverables, risks, pricing or resources.
- **Meeting minutes**: summary, decisions, action items, owners, deadlines, open questions.
- **Product plan**: problem, users, goals, requirements, flow, milestones, acceptance criteria.

For long drafts:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/check_document_structure.py"` and `arguments: ["draft.md", "--expect", "Executive summary,Recommendations,Next steps"]`.

When using a template asset, replace placeholders and empty table rows with user-specific content before creating the DOCX.

## Field And Package Safety

- Prefer a static contents section when Microsoft Word is unavailable.
- For a dynamic TOC on Windows, create the field, update it once in Word, save the cached result, then disable open-time updating before delivery.
- Never remove `w:updateFields` from a document whose TOC has no cached result; this leaves a blank contents page. The repair script refuses this case.
- Treat `LINK`, `INCLUDETEXT`, `INCLUDEPICTURE`, `DDE`, `DDEAUTO`, `DATABASE`, and `RD` fields as blocking unless explicitly required and reviewed.
- Ordinary `http`, `https`, and `mailto` hyperlinks are allowed but are reported by the validator.
- User-facing web links must use native external hyperlink relationships and the visible Word `Hyperlink` character style. Plain black source titles without their URL are not acceptable delivery.

Validate the finished package:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/validate_docx.py"` and `arguments: ["output.docx"]`.

Visible Markdown syntax or a probable raw-source dump table is a blocking validation failure. Regenerate through `mcp__assistant__create_file` after correcting the input fields. Use `--allow-markdown-literals` only when the document intentionally teaches or quotes Markdown syntax.

If Word has already updated and cached the fields but the file still enables open-time updating, write a new copy:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/repair_docx.py"` and `arguments: ["source.docx", "fixed.docx"]`.

## Quality Bar

- The document should be skimmable from headings alone.
- The first page should clarify purpose and conclusion quickly.
- Tables should be used for comparisons, action items, timelines, and requirements.
- Important caveats and assumptions should be explicit.
- A document title must appear once. Do not repeat the full source or append a Markdown copy after the formatted body.
- Warn when a long report or proposal has no native heading paragraphs; Unicode replacement characters and an empty visible body are blocking.
- Tables must be real Word tables, emphasis must be real run formatting, and numbered or bulleted content must use native list properties.
- The `.docx` must pass ZIP/CRC/XML, relationship, field, TOC-cache, and open-time-update validation.
- Image-bearing documents must contain internal `word/media/*` parts and internal image relationships; linked local files are not deliverable media.
- The resolved style, source (`explicit`, `brand`, `inferred`, or `default`), mode, and `document_type` must be present in the `create_file` result for traceability.
