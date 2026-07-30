---
name: pdf
description: Read, summarize, extract, create, validate, split, merge, inspect, and process PDF documents, including OCR-style extraction, forms, scanned documents, reports, papers, contracts, invoices, and document conversion. Use when the user asks for PDF, scanned PDF, OCR, extract text/table, summarize a PDF, create PDF, PDF处理, PDF读取, OCR识别, or 文档提取.
---

# PDF

Treat PDFs as source documents or final deliverables, depending on the task.

## Operating Rules

- Identify whether the user wants extraction, summary, transformation, validation, or a new PDF.
- Preserve source attribution: page numbers, sections, table names, or file names when available.
- For generated output, use `mcp__assistant__create_file` with `format: "pdf"` when a simple verified PDF is sufficient.
- For generated reports, pass markdown-like headings, ordered or unordered lists, quotes, fenced code, and pipe tables in `content`; the built-in generator performs measured wrapping, table pagination, repeated table headers, and page numbering.
- For a real local image, pass it in `assets` as `{ id, file_path, alt_text }` and place `![descriptive alt text](asset:id)` on its own line in `content`. The generator embeds the normalized PNG rather than linking the source file.
- For PDF reading, use available file-reading/OCR tools first. If extraction quality is poor, say so and ask for a clearer file or image only when needed.
- Do not invent text from unreadable pages.
- Do not write plain text with a `.pdf` extension.
- Do not add JavaScript, launch actions, embedded files, automatic open actions, or external file links to generated PDFs.

## Shared Visual Style System

- The user does not need to name this Skill or a style ID. Pass a specific `document_type`; normally omit `visual_style` and let `create_file` infer it from the title and content.
- Shared styles cover formal business (`executive`, `corporate`, `consulting`, `finance`, `government`, `legal`), knowledge and product (`academic`, `research`, `technology`, `product`, `data`), communication (`startup`, `sales`, `brand`, `editorial`), human topics (`education`, `children`, `training`, `healthcare`, `sustainability`, `culture`, `warm`), and expressive or neutral directions (`premium`, `creative`, `bold`, `minimal-light`, `minimal-dark`, `monochrome`, `custom-brand`).
- Use explicit `visual_style` only for a requested direction. Use `brand_theme` only with supplied brand colors. `style_mode: "dark"` is suitable for controlled screen-first publications; `print` produces grayscale, print-friendly output.
- PDF is a fixed-layout deliverable, so it may express the style more strongly than DOCX through page background, page rail or top rule, title scale, accent marker, quote panel, code panel, table header, body surface, and footer. Preserve measured wrapping, searchable CJK text, pagination, and safe margins in every style.
- A brochure, white paper, event program, product catalog, academic publication, policy handbook, and printable workbook should not collapse into the same report template merely because they all use PDF.

## Runtime Contract

- Use `mcp__assistant__ocr_file` for image or scanned-PDF OCR. Do not install or improvise an OCR package.
- Run bundled scripts with `mcp__assistant__python_execute` using the script's actual installed Skill path and `arguments`; do not probe or modify system Python.
- Use `mcp__assistant__python_execute` only when structured data processing is needed after extraction.

## Bundled Resources

- Read `references/pdf-workflows.md` for scanned PDFs, exact extraction, table-heavy PDFs, citations, or PDF-to-report workflows.
- Use `scripts/extraction_quality_check.py` on extracted text when the document is scanned, table-heavy, long, or when exact numbers matter.
- Run `scripts/validate_pdf.py` on every generated PDF before reporting success.
- Use `assets/extraction-schema.json` when a PDF needs structured extraction with page references, key facts, tables, uncertain text, and quality notes.

## Extraction Pattern

When reading a PDF:

1. Identify document type and page count if available.
2. Extract title, authors/source, dates, headings, tables, and figures.
3. Separate facts from interpretation.
4. Preserve page references for important claims.
5. Summarize with actions or implications when relevant.

For uncertain extraction:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/extraction_quality_check.py"` and `arguments: ["extracted.txt"]`.

## OCR Pattern

- Call `mcp__assistant__ocr_file` with `provider: "auto"` first and preserve returned page numbers. Omit `languages` for Simplified Chinese plus English; add `zh-tw` only when the source actually contains Traditional Chinese.
- Let Auto compare system OCR with Tesseract for mixed Chinese/English content. For other content, Auto runs Tesseract when the system result is weak and performs one high-contrast Tesseract retry only when all normal candidates remain weak.
- Preserve the tool's line breaks, blank lines, paragraph order, and page boundaries when writing TXT or Markdown. Never flatten OCR text into one line.
- Treat TXT/Markdown as reading-order output, not an exact reconstruction of page coordinates, columns, typography, or tables. State this limitation only when the user asks for layout fidelity.
- Check `status`, `page_results`, `low_confidence_pages`, and the returned provider list before reporting completion. If the tool returns `completed_with_warnings`, identify the uncertain pages and do not claim exact extraction.
- Inspect names, numbers, dates, punctuation, and bilingual passages against the source when accuracy matters.
- Flag uncertain names, numbers, dates, and tables.
- Ask for a higher-resolution source only when needed.

## Generated PDF Workflow

1. Structure the report with `#`/`##` headings, short paragraphs, lists, and Markdown pipe tables.
2. Call `mcp__assistant__create_file` with `format: "pdf"`, a real title, and the structured content. Include `assets` for referenced images; PDF page rendering runs automatically, and high-stakes output should set `render_validation: "required"`.
3. Validate structure, extractable text, expected title text, and CJK coverage:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/validate_pdf.py"` and `arguments: ["output.pdf", "--require-cjk", "--expect-text", "Zen AI", "--single-title", "--no-markdown-literals"]`.

4. For high-stakes output, visually inspect every page for clipping, blank pages, and table splits.

## PDF Integrity Guardrails

- Use the bundled Noto Sans CJK SC font for Chinese output. Verify required glyph coverage before saving; never deliver missing-glyph boxes.
- Wrap by measured font width rather than character count.
- Keep table rows inside the printable area, repeat table headers on continuation pages, and never silently truncate cell text.
- Keep the visible document title singular. Do not draw the explicit title and then repeat an identical leading H1 from the source.
- Convert Markdown authoring markers into PDF structure; do not expose `#`, `**`, code fences, or table separator rows in the final pages.
- Treat encryption, JavaScript, launch actions, embedded files, non-web external actions, blank pages, and missing expected text as blocking.
- Ordinary `http`, `https`, and `mailto` links are reported as warnings.
- Require `pdf-rendered-pages` and `render_verification: passed` before reporting generated PDF delivery. A structurally valid but blank rendered page is a blocking failure.
- Never report completion if `validate_pdf.py` exits nonzero.
- Require the resolved style metadata in the `create_file` result and visually compare dark, light, and print outputs when the user requests variants.

## Quality Bar

- Key facts should be traceable to the source document.
- Numbers and dates should be checked twice.
- Tables should be converted into structured rows when possible.
- Generated PDFs must pass structural, text-extraction, font, page-content, and action-safety validation.
