---
name: meeting-notes
description: Turn meeting transcripts, rough notes, audio transcriptions, chat logs, and discussion records into concise meeting summaries, decisions, action items, owners, deadlines, risks, and follow-ups. Use when the user asks for 会议纪要, meeting notes, minutes, action items, 待办, 决议, 会议总结, 整理会议记录, or follow-up extraction.
---

# Meeting Notes

Convert messy discussion into a useful record people can act on.

## Operating Rules

- Preserve decisions, owners, deadlines, and unresolved questions.
- Do not invent owners or dates. Mark missing values as `TBD` or ask if they are critical.
- Separate facts from interpretation.
- If the transcript is long, summarize by topic before extracting action items.
- If the user asks for a document, follow the complete `$docx` or `$pdf` workflow and require that format's final validator to pass.
- Run bundled scripts with `mcp__assistant__python_execute`; do not probe or install into system Python.

## Bundled Resources

- Read `references/meeting-patterns.md` for long transcripts, formal minutes, executive summaries, or follow-up messages.
- Use `scripts/extract_actions.py` on long notes, transcripts, or chat logs to catch likely action items.
- Use `assets/meeting-minutes-template.md` when the user asks for a formal document or wants a consistent meeting notes format.

## Default Output

Use this structure:

1. Meeting summary
2. Key decisions
3. Action items
4. Risks and blockers
5. Open questions
6. Follow-up message draft, if useful

Action item table:

| Task | Owner | Deadline | Priority | Notes |
| --- | --- | --- | --- | --- |

For extraction:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/extract_actions.py"` and `arguments: ["transcript.txt", "--out", "actions.json"]`.

## Quality Bar

- A reader who missed the meeting should know what happened and what to do next.
- Action items should start with verbs.
- Decisions should be explicit and not mixed with discussion.
- Risks should include impact and suggested mitigation when possible.
