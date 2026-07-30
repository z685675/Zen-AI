# PDF Workflows

Use this reference when handling PDFs as source documents or final deliverables.

## Reading PDFs

1. Identify document type, page count, title, source, and date.
2. Extract headings, tables, figures, footnotes, and appendices separately when possible.
3. Track page references for important claims.
4. Separate source facts from interpretation.
5. If extraction is weak, state the limitation and avoid overconfident summaries.

## Scanned Or OCR PDFs

- Expect missing characters, broken lines, and table distortion.
- Check names, numbers, dates, and totals twice.
- Ask for a clearer source only when the current file cannot support the requested answer.

## Extraction Quality

Run `scripts/extraction_quality_check.py` on extracted text when:
- the PDF is scanned or image-heavy,
- the summary depends on exact numbers,
- tables matter,
- the text looks fragmented,
- the document is long and needs citations.

## Final PDF Creation

Use `mcp__assistant__create_file` with `format: "pdf"` for generated PDFs. Supply markdown-like headings, lists, and pipe tables so the generator can paginate structured content. For highly designed layouts, create a DOCX/PPTX draft first when that is more editable.

Before delivery:

- require bundled CJK font coverage for Chinese,
- verify no blank pages or truncated tables,
- reject JavaScript, launch actions, embedded files, and external file links,
- run `scripts/validate_pdf.py` with expected title text and `--require-cjk` when Chinese is required.
