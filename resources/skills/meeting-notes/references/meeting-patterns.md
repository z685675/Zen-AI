# Meeting Notes Patterns

Use this reference for turning messy discussion into an actionable record.

## Default Structure

- Meeting summary
- Key decisions
- Action items
- Risks and blockers
- Open questions
- Follow-up message draft

## Decision Rules

- Decisions are explicit commitments, not opinions.
- Action items need task, owner, deadline, priority, and notes.
- If owner or deadline is missing, mark it as `TBD` rather than inventing it.
- Risks should include impact and mitigation when possible.

## Transcript Handling

- Group long transcripts by topic before writing the final summary.
- Remove repeated discussion unless it changes the decision.
- Preserve dissenting opinions when they affect risk.
- Run `scripts/extract_actions.py` on long notes to catch likely follow-ups.
