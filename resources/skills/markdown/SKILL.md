---
name: markdown
description: Create, edit, structure, validate, and polish Markdown/MD documents, README files, technical notes, specifications, knowledge-base pages, reports, and text deliverables. Use when the user asks for Markdown, MD, README, documentation, a structured text file, 知识库文档, 技术文档, or Markdown 格式交付.
---

# Markdown

Create Markdown that is readable as source, renders predictably, and remains portable across common viewers.

## Operating Rules

- Identify the document type, audience, required sections, and whether links or local assets are needed.
- Use `mcp__assistant__create_file` with `format: "md"` for the final file.
- Use one clear H1 for a standalone document. Organize long documents with sequential H2/H3 sections.
- Close every fenced code block and specify a language when the content is code.
- Keep pipe tables compact. Use lists or sections when cells would contain long paragraphs.
- Use relative paths for bundled local assets and verify that every referenced file exists.
- Do not place credentials, private tokens, executable `javascript:` links, or embedded `data:` payloads in generated Markdown.
- Do not claim completion merely because the file exists; validate its source structure first.

## Runtime Contract

- Run bundled scripts with `mcp__assistant__python_execute` using the Skill's installed path and `arguments`.
- If another approved workflow produces the final Markdown file outside `mcp__assistant__create_file`, call `mcp__assistant__present_files` with the verified final path before replying.
- Do not use system Python or install Markdown packages. The validator uses the managed standard library.

## Workflow

1. Draft the document with a clear title and section hierarchy.
2. Write the final `.md` through `mcp__assistant__create_file`.
3. Validate it:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/validate_markdown.py"` and `arguments: ["output.md", "--strict", "--check-links"]`.

4. Fix unclosed fences, malformed tables, unsafe links, missing local assets, or heading-order errors before reporting success.

## Quality Bar

- UTF-8 text contains no replacement characters or unsupported control characters.
- A standalone document has exactly one H1 and does not skip heading levels.
- Code fences are balanced, tables have consistent columns, and local links resolve.
- The source remains easy to read without a renderer; avoid raw HTML unless the user explicitly needs it.
- Never report completion when strict validation fails.
