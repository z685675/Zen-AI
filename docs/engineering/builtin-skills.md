# Built-in skill maintenance

The product ships selected skills and keeps the existing external import entry. There is no plugin marketplace UI or automatic third-party plugin installation. Native OpenCode remains responsible for execution, permissions, retries and compaction.

## Selected resources (2026-10-27)

| Existing skill | Change | Upstream |
| --- | --- | --- |
| content-writer-cn | Optional natural-language polishing reference, preserving facts, uncertainty and author voice | Humanizer-zh, MIT, f4518a8eab97b8bfebc66a89d34320a89bef6930 |
| academic-research | Offline bibliography checks and selective DOI metadata retrieval | K-Dense scientific-agent-skills, MIT, 5f2bc0341354fd5590aef76a533ada1e1e5b4e62 |
| paper-writing | Offline numeric/methods/results registry checks | Same K-Dense revision |
| docx/xlsx/pptx/pdf/presentation-planner | Existing generators retained; explicit delivery counts, formulas, actual paths and final-page text are acceptance requirements | Existing implementation |
| skill-creator | Native OpenCode maintenance runner, isolated workspaces, valid/error outcomes and explicit opt-in benchmarks | Existing Apache-licensed skill adapted locally |

Imported files have per-skill references/upstream.json checksums and adjacent licenses. The two K-Dense _common.py modules are different and stay in separate directories. Do not overwrite them with one shared module. The citation helpers require requests, included in managed Python profile 2; its runtime package must be rebuilt/published as part of a release that distributes this profile.

DOI existence does not verify bibliography metadata or claim support. The metadata helper supplies records for explicit comparison. Inspect duplicate and unverified warnings separately from exit codes. Numeric checks cover a registry extracted from a manuscript, not the original binary document or the truth of the evidence. A placeholder or empty registry is not substantive verification.

## Research checkpoints (2026-11-08)

Deep Research is question-led professional investigation: review an editable
plan, investigate relevant evidence, compare explanations/options, and deliver
guidance with citations, uncertainties and actionable next steps. It is not a
default paper acquisition pipeline. Preserve difficult questions and agreed
depth; paper methods/data are read when the conclusions require them.

Native task context and compact evidence/gap notes are the default. Source counts
and page counts are not report completion criteria. Do not require a database,
source matrix, saved full report or strict numeric gate for every chat report;
those helpers are optional for durable tracking, reproducible studies or an
explicit citation audit. Generate the report once for the chosen delivery format,
reuse it for later exports, and keep the existing plan/start/revise task boundary.

Explicit academic work follows the user's goal (discovery, supplied-paper analysis,
review or drafting). A scientific topic alone does not select paper acquisition.
Users need not name websites. Necessary academic browser automation first agrees
on sites, purpose and reading/download scope, including the save destination;
explicit consent in the request or confirmed plan is reused for that task.
Ordinary public search/targeted reads and analysis of uploaded PDFs do not require
a browser session. New sites or expanded operations need confirmation; a refused
operation leaves authorized research active. Login/CAPTCHA and restricted actions
retain their existing handoff requirements.

This is a conversational workflow implemented in the runtime instructions and
Skills, using the existing permission/handoff system. It is not a new per-domain
network allowlist or a sandbox for arbitrary browser JavaScript. Build's native
tool permissions and OpenCode's execution loop remain unchanged. Validate model
behavior with the research/academic cases in find-skills/assets/acceptance-prompts.json;
unit tests and Skill audits do not prove a live model followed these instructions.

Optional Deep Research checkpoints use the original, offline standard-library helper
`research-report/scripts/research_state.py`. It records batched read reservations,
DOI/URL aliases, outcomes, evidence levels and per-question coverage in a per-task
SQLite database under the authorized workspace. OpenCode still executes tools and
owns its native loop. The helper never fetches sources or auto-solves CAPTCHA.
Read `research-report/references/research-checkpoints.md` for resumption, budgets
and the limitations of numeric coverage. The design was informed by
[Foundry's source ledger](https://github.com/foundry-works/foundry-research/blob/16249598774c2d284ba7725f112326c055b29c0d/skills/deep-research/scripts/state.py)
and bounded research iterations in
[Open Deep Research](https://github.com/langchain-ai/open_deep_research/blob/1b7d2e80db9faa586165c60e09096dbbfd483a64/src/open_deep_research/deep_researcher.py);
no third-party execution engine or code was copied into this helper.

Known invalid read-only calls (missing search query/page URL) are rejected at the
native doom-loop permission boundary without asking the user to approve malformed
work. One synthetic repair is allowed in the same history; another invalid loop
finishes from existing evidence with tools denied. Valid repetitions, unknown tools,
writes and ordinary permission decisions keep their original approval behavior.

Offline checkpoint regressions: `python -X utf8 -B scripts/__tests__/research_state_test.py`.

## Installation

Global built-ins use a per-file SHA-256 inventory, including scripts and references. A changed bundle or missing installed file is repaired even if the app version is unchanged. Legacy/locally modified content is copied to Data/SkillBackups before replacement. Unrelated user files remain; retired manifest-owned files are removed after backup when necessary. Backup folders are outside enabled skill roots. Enabled/disabled DB state is preserved. Workspace role provisioning already fingerprints source trees and updates its own copies.

## Evaluation

### Document workflow checks (2026-11-06)

The four document skills reuse completed generator checks on unchanged files. Script edits use `validate_file` on the current working copy rather than recreating a document from old source content. This tool shares the bounded, authorized delivery reader; it neither changes files nor registers additional delivery cards. Explicit rendering uses the existing Office pipeline, including its Windows Office fallback, timeouts and isolated conversion paths.

DOCX `expected_pages` is verified against actual rendered PDF pages, never cached OOXML properties. Missing required rendering, skipped rendering or a page-count mismatch fails validation. A standalone `<!-- pagebreak -->` creates a native Word page break. The default Normal paragraph style supports independent editors while retaining the generator's typography and pagination defaults. This verifies physical pagination, not perfect visual design or factual correctness.

PPTX reference/template workflows, visual styles and story/layout contracts live in separate references loaded when needed. Their rules are retained; shorter entry instructions do not weaken complex-task acceptance requirements. No third-party Office runtime or proprietary skill package was added. Future imports must pin and inspect the actual per-skill license, dependencies and Windows behavior before comparison on identical tasks.

Ordinary user tasks do not run trigger optimization. The maintenance runner requires an explicit OpenCode executable and provider/model configuration. It cannot inherit the app's private credentials through the managed Python tool. See the skill-creator OpenCode evaluation reference for configuration. It runs with only the candidate skill in a temporary workspace, disables other tools/plugins/MCP, and disables title generation to avoid extra model requests.

Runtime errors and timeouts count as errors, including for negative cases. An unfinished response or failed tool must not improve an evaluation score. Description selection tests do not establish output quality or real-world speed. Use the same model/provider/task for old/new comparisons; acceptance-prompts.json includes fact-preservation, citation, numeric-conflict and exact-delivery regressions.

Offline Python checks (Python 3.11+, requests in the maintenance environment):

```text
python -X utf8 -B scripts/__tests__/builtin_skills_test.py
python -X utf8 -B resources/skills/find-skills/scripts/audit_builtin_skills.py resources/skills
```

For the optional cost-free native integration check, set ZEN_SKILL_NATIVE_SMOKE=1 and ZEN_OPENCODE_EXECUTABLE to the bundled native binary before running the Python checks. The fixture uses a loopback model server and the bundled offline dependencies; it makes no paid requests. It checks positive/negative native skill selection and description generation.

## OpenCode kernel

The runtime, offline plugin and SDK are pinned to 1.19.5. Keep root package/lock, offline package/lock, runtime version checks and packaging checks synchronized. The version upgrade removes upstream session sharing and adjusts reasoning-option variants; this product does not invoke sharing endpoints. Revalidate model switching/effort, permissions, events, attachments and compaction when upgrading. `pnpm smoke:opencode --reasoning` additionally checks GPT-style native apply_patch and that the configured high reasoning effort reaches the loopback model request. A version upgrade alone is not evidence of reduced task latency.
