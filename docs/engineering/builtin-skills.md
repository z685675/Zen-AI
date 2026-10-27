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

## Installation

Global built-ins use a per-file SHA-256 inventory, including scripts and references. A changed bundle or missing installed file is repaired even if the app version is unchanged. Legacy/locally modified content is copied to Data/SkillBackups before replacement. Unrelated user files remain; retired manifest-owned files are removed after backup when necessary. Backup folders are outside enabled skill roots. Enabled/disabled DB state is preserved. Workspace role provisioning already fingerprints source trees and updates its own copies.

## Evaluation

Ordinary user tasks do not run trigger optimization. The maintenance runner requires an explicit OpenCode executable and provider/model configuration. It cannot inherit the app's private credentials through the managed Python tool. See the skill-creator OpenCode evaluation reference for configuration. It runs with only the candidate skill in a temporary workspace, disables other tools/plugins/MCP, and disables title generation to avoid extra model requests.

Runtime errors and timeouts count as errors, including for negative cases. An unfinished response or failed tool must not improve an evaluation score. Description selection tests do not establish output quality or real-world speed. Use the same model/provider/task for old/new comparisons; acceptance-prompts.json includes fact-preservation, citation, numeric-conflict and exact-delivery regressions.

Offline Python checks (Python 3.11+, requests in the maintenance environment):

```text
python -X utf8 -B scripts/__tests__/builtin_skills_test.py
python -X utf8 -B resources/skills/find-skills/scripts/audit_builtin_skills.py resources/skills
```

For the optional cost-free native integration check, set ZEN_SKILL_NATIVE_SMOKE=1 and ZEN_OPENCODE_EXECUTABLE to the bundled native binary before running the Python checks. The fixture uses a loopback model server and the bundled offline dependencies; it makes no paid requests. It checks positive/negative native skill selection and description generation.

## OpenCode kernel

The runtime, offline plugin and SDK are pinned to 1.19.4. Keep root package/lock, offline package/lock, runtime version checks and packaging checks synchronized. The version upgrade removes upstream session sharing and adjusts reasoning-option variants; this product does not invoke sharing endpoints. Revalidate model switching/effort, permissions, events, attachments and compaction when upgrading. `pnpm smoke:opencode --reasoning` additionally checks GPT-style native apply_patch and that the configured high reasoning effort reaches the loopback model request. A version upgrade alone is not evidence of reduced task latency.
