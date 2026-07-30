---
name: find-skills
description: Helps users discover built-in or installable agent skills when they ask what skill can do a task, ask "how do I do X", "find a skill for X", "is there a skill for X", "有什么 skill", "有什么技能", or express interest in extending capabilities. Use this skill before answering skill-discovery questions.
---

# Find Skills

Help users discover whether an existing Skill can solve their task, starting with built-in Skills before searching external marketplaces.

## Operating Rules

- First check the currently available or built-in Skills.
- Read `references/builtin-catalog.md` when the user asks what Skills exist or asks for common document, PPT, spreadsheet, research, content, meeting, PDF, or Skill creation capabilities.
- Use `scripts/audit_builtin_skills.py` when validating the built-in Skill bundle during development or release checks.
- Use `assets/acceptance-prompts.json` as the standard prompt set when manually testing built-in Skill routing and artifact quality.
- Recommend a built-in Skill when it covers the need. Explain the practical workflow, not just the Skill name.
- Search external Skills only when the built-in set does not cover the need or the user explicitly asks for marketplace/community Skills.
- If the user asks whether Skills are "just prompts", explain that a Skill can include `SKILL.md`, `scripts/`, `references/`, and `assets/`.

## Built-In First Workflow

1. Identify the user's task domain and desired artifact.
2. Match it against the built-in catalog.
3. If there is a good match, name the Skill and describe how it helps.
4. If there is no good match, search external Skills.
5. If external install is needed, show source and security warning before installing.

## Built-In Audit

During development or release checks, run:

Call `mcp__assistant__python_execute` with the installed `scripts/audit_builtin_skills.py` as `script_path` and the built-in Skill root as its only argument.

Fix missing frontmatter, broken resource links, Python syntax errors, and bundled cache files before shipping.

For manual acceptance testing, run the prompts in `assets/acceptance-prompts.json` and check that the expected Skill workflow is used before final output.

## External Search

Use the Skills CLI when marketplace discovery is needed:

```bash
npx skills find <query>
```

If `npx` is unavailable, use the bundled bun exposed by Zen AI:

```bash
"$CHERRY_STUDIO_BUN_PATH" x skills find <query>
```

Try specific queries such as:

- `pptx presentation design`
- `react testing`
- `pdf extraction`
- `research report`
- `browser automation`

## Install Safety

Skills from external sources may include scripts and run with agent file access. Before installing:

- Show the source link.
- Explain that third-party Skills can read or modify project files.
- Ask for explicit user confirmation.
- Only after confirmation run:

```bash
npx skills add <owner/repo@skill> -y
```

## Response Pattern

When a built-in Skill fits:

```text
有，优先用内置的 `pptx` Skill。它不只是提示词，还会按 deck spec 规划页面，并可用脚本校验标题、布局、takeaway、视觉建议和内容密度，然后再生成真实 PPTX。
```

When no Skill fits:

```text
目前内置 Skill 没覆盖这个细分场景。我可以直接处理，也可以帮你搜索外部 Skill；外部 Skill 安装前需要先看来源和确认权限风险。
```
