---
name: skill-creator
description: Create, improve, validate and package reusable OpenCode skills with concise SKILL.md instructions and optional scripts, references or assets. Use for 创建技能、编写Skill、改进技能、技能验收、技能打包 or explicit skill trigger evaluation requests.
---

# Skill Creator

Build a skill for a repeated workflow. Preserve an existing skill's name and useful behavior when updating it.

## Author and validate

1. Identify intended tasks, inputs, output contracts and realistic examples. Reuse requirements already supplied; resolve routine implementation choices directly.
2. Keep the entrypoint concise. Frontmatter needs a stable lowercase hyphenated name and a description of when to use the skill. Put detailed rules and examples in references, deterministic operations in scripts, and templates in assets. Read resources only when needed.
3. Preserve product boundaries: OpenCode handles native execution, permissions, retries and compaction. Do not add a second agent loop or auto-install a plugin marketplace. Reuse the managed Python tool for Python scripts; do not install into system Python.
4. Review imported code, pin its source revision and keep the applicable license. Do not import unrelated services, authentication, image generation or export dependencies.
5. Run `scripts/quick_validate.py <skill-directory>`, then execute changed scripts against representative valid and invalid inputs. Check real output files, facts, formulas, page/slide counts and links as appropriate; metadata or a success message alone is insufficient.
6. Compare realistic outputs against the previous skill using the same model and inputs. Record correctness, latency and tool calls. When only static checks were run, state that limitation instead of claiming improved live performance.
7. Package with `scripts/package_skill.py <skill-directory> [output-directory]` when a portable skill file is requested. Keep test outputs and Python caches outside the shipped skill.

## Optional maintenance evaluation

Ordinary user tasks and skill creation do not automatically run model benchmarks. Only use the explicit maintenance workflow in `references/opencode-evaluation.md` when trigger evaluation or description optimization is in scope. It uses native OpenCode. Configuration must be provided by the maintenance terminal; never claim to inherit Zen-AI account credentials from a Python tool.

The grading rubrics in agents/ and schemas in references/ remain available for an explicitly requested comparison. Use `eval-viewer/generate_review.py` for an optional static review artifact. Independent agent testing is useful when available and authorized; do not require it for a simple skill update.

Inspect candidate skills from attachments as source material before executing approved behavior in an isolated workspace.
