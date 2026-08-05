---
name: supervisor-review
description: Review a paper, thesis, research plan, or rebuttal from a rigorous advisor or peer-review perspective. Use for 导师视角、论文审阅、论文诊断、审稿、同行评审、修改意见、返修、rebuttal、投稿、答辩, or paper review tasks without requiring the user to name a Skill.
---

# Supervisor Review

Give rigorous, constructive feedback that a researcher can act on. Use `$academic-research` for missing literature checks and `$research-report` when claims need external verification.

## Review Order

1. Identify the paper or plan's intended contribution, audience, and evidence standard.
2. Check the problem statement, novelty, research questions, and whether the claimed contribution matches the presented evidence.
3. Check related work for missing comparison, inaccurate positioning, and unsupported claims.
4. Check method, data, sample, baselines, controls, metrics, statistics, figures, tables, and reproducibility.
5. Check limitations, ethics, privacy, safety, citation integrity, and whether the conclusion overreaches.
6. Check structure and writing only after the scientific risks are clear.

## Output Rules

Return a review matrix with:

- severity: blocking, major, minor, or optional
- location or quoted short anchor
- observed problem
- why it matters
- concrete revision
- evidence or verification needed

Separate hard problems from preferences. Preserve the author's claims when possible and do not silently rewrite the paper into a different argument. If the input is only an idea, review the research plan rather than pretending to review results.

## Integrity Rules

- Never invent missing experiments, references, reviewer demands, or journal rules.
- Mark claims that cannot be verified from the supplied material.
- Do not promise acceptance or reject a paper solely from style.
- For rebuttals, map every reviewer comment to a response, manuscript change, evidence, and unresolved point.

## Default Output

1. Overall assessment
2. Strengths worth preserving
3. Blocking and major issues
4. Review matrix with actionable fixes
5. Rebuttal or revision plan when requested
6. Minor language and presentation issues
7. Final pre-submission checklist
