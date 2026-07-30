---
name: presentation-planner
description: Plan the storyline, structure, slide-by-slide outline, deck spec, visual direction, and speaker notes for presentations before generating PPTX. Use when the user asks for PPT大纲, slide outline, presentation structure, story line, pitch deck planning, 汇报思路, 路演结构, 课件大纲, deck planning, or requests a mature multi-slide, executive, commercial, pitch, report, or presentation-ready deck that needs planning before file creation, even without naming this Skill.
---

# Presentation Planner

Turn a rough idea into a presentation plan that can later become a strong PPTX.

## Operating Rules

- Plan before writing slides. A deck needs a thesis, audience logic, and narrative flow.
- Use conclusion-style slide titles.
- Keep each slide focused on one message.
- Design for the occasion: leadership report, investor pitch, training, sales, academic talk, product proposal, or project review.
- If the user asks for a PPTX after planning, hand off to the `pptx` workflow and use the planned slide fields.
- Infer a `document_type` from the occasion and leave deck colors to the PPTX shared visual style system. Do not auto-assign a rotating `accent` to every slide; an explicit accent is only for a user-requested or semantically necessary exception.
- Infer one internal composition profile from occasion, audience, density, and mood: `structured` for reports and decisions, `spatial` for place/architecture/portfolio stories, and `kinetic` for launches, festivals, campaigns, exhibitions, and live events. The user never needs to name it, and one profile should remain coherent within a deck.
- Plan composition rhythm, not just layout labels. Avoid consecutive title-plus-box pages; alternate a dominant statement, open rows, comparison, process/timeline, metrics or chart, quote/image evidence, and a closing action structure according to the story.
- Treat visual style as geometry and hierarchy. The same outline rendered as consulting, technology, children, brand, or premium should change cover structure, reading path, whitespace, and shape language rather than only palette.
- Use `network`, `matrix`, `schedule`, and `route` when the message is relational, quadrant-based, time-programmed, or journey/spatial-path based. Do not convert these semantics into generic cards or a process slide merely because those layouts are familiar.
- Classify a supplied source before planning. Use `pptx_style_reference` when the user wants an approximate visual direction; record a representative 1-based `slide_number` when one page is the exemplar. The casual word "template" is not enough to force native geometry. Use `pptx_template` `edit-copy`/`new-deck` only for native page or object preservation, and `adaptive-design` when the user admires the source aesthetic but the new story needs different compositions.
- For `pptx_style_reference`, let the reference determine the layout language and omit `visual_style` even when the new topic suggests another automatic category. Profile the source's picture/chart cadence, light/dark rhythm, text density, and layout diversity, then plan comparable output composition rather than copying only its colors.
- If a PPTX reference is image-heavy, include a topic-relevant asset plan with local file paths and `image_asset_id` assignments. Plan enough distinct visuals to preserve media variety; one or two repeated illustrations are not an acceptable substitute for a photo-led source. Do not reuse semantically unrelated source photos, and do not write an image intention into `visual` without arranging a real asset.
- For brand, culture, showcase, event, place, portfolio, and product-launch decks without a reference, create a visual-asset plan when images would materially carry the story. Use distinct real or generated topic assets through `assets` plus `image_asset_id`; if no trustworthy asset is available, choose an intentional typographic fallback instead of pretending `visual` prose is embedded media.
- Use `pptx_template` when the user asks to edit selected pages, preserve the original master/layout/placeholders, reuse exact source pages, or use an editable PPTX as a design source. Plan `target_slide_number`, `template_slide_number`, `preserve_content`, and replacement `image_asset_id` values only for native reuse. For `adaptive-design`, plan semantic layouts and assets normally while the runtime supplies the reference-derived visual language.
- A minimal request containing only the source template and new topic is sufficient. Infer the audience, storyline, slide count, source-page mapping, output name, media replacements, source protection, validation, and internal retry plan without asking the user for technical constraints.
- For every new-topic template request, call `mcp__assistant__inspect_pptx_template` before drafting slides. Build the new-topic storyline from scratch, then compare its required semantic pages with the inspected source inventory. Prefer `new-deck` when most pages fit; choose `adaptive-design` when multiple important pages would otherwise be distorted.
- Treat the inspection output as both a design-language profile and a layout contract. Preserve palette strategy, typography scale, alignment, shape language, density, image treatment, and page rhythm. For native reuse, also match arrangement, item capacity, topic media, chart kind, and `target_body_text_units_min/max`. Retry internally when a result is too sparse, leaves empty repeated slots, retains stale semantic icons/images/data, or truncates content.
- Plan within the supported fidelity: a native PPTX page can be preserved without rewriting its slide XML, while mapped text edits retain native geometry and styling. Screenshots guide palette and broad visual direction only; do not promise screenshot-to-editable-object reconstruction or hide the screenshot as a full-page background.
- Run bundled scripts with `mcp__assistant__python_execute` using the script's actual installed Skill path and `arguments`; do not probe or install into system Python.
- On Windows, read Skill Markdown and JSON as UTF-8, for example with `Get-Content -Raw -Encoding utf8`.

## Bundled Resources

- Read `references/deck-patterns.md` when choosing a storyline for leadership reports, product proposals, sales/investor pitches, or training decks.
- Use `scripts/outline_to_deck_spec.py` when the user provides Markdown notes, a rough outline, or long pasted material that needs conversion into a structured deck spec.

## Planning Workflow

1. Define audience, goal, decision, desired impression, and whether any supplied PPTX/screenshot is an approximate style reference or a native template/edit source.
2. Write the core thesis in one sentence.
3. Choose a narrative pattern:
   - problem -> insight -> solution -> plan
   - context -> evidence -> options -> recommendation
   - current state -> gap -> roadmap -> action
   - audience pain -> product value -> proof -> next step
4. Create section groups.
5. Create a slide-by-slide outline with layout, takeaway, visual idea, and speaker notes.
   - When a source PPTX is present, add an internal design manifest: strategy, design-language traits, target density, source-page mapping if native, and the reason each composition fits.
6. For rough Markdown input, create a first-pass spec:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/outline_to_deck_spec.py"` and `arguments: ["notes.md", "--title", "Deck title", "--out", "deck.json"]`.

## Slide Plan Format

For each slide include:

- Slide number
- Title as a conclusion
- Layout type
- Core message or takeaway
- Visual suggestion
- 3-5 content points
- Speaker note or transition

For source-guided work, also record internally:

- `strategy`: `new-deck` or `adaptive-design`
- semantic page role and why the chosen composition fits
- target information density and image slot role
- source page number only when native reuse is selected

At deck level, include `document_type`. Normally omit `visual_style` so the generator can infer it from the topic and content; include it only when the user requests a visual direction. Always omit it when `pptx_style_reference` is present so topic inference cannot replace the reference layout language. Preserve an approximate reference as `pptx_style_reference`; preserve an exact editable PPTX source as `pptx_template` and map source/target pages explicitly. Use supplied brand colors through `brand_theme`, never invented brand hex values.

Prefer `timeline` for milestones, `network` for ecosystems, `matrix` for four-quadrant decisions, `schedule` for timed programs, `route` for journeys or spatial paths, `chart` for label:value data comparisons, and `quote` for customer proof or a memorable thesis.

Before handing a plan to the PPTX workflow, enforce the layout contracts: `metric` requires compact numeric values, `timeline` uses `period | milestone: detail`, `network` uses 3-6 `node | detail` items, `matrix` uses exactly four `quadrant | detail` items, `schedule` uses `time | event: detail`, `route` uses `stop | milestone: detail`, `process` and `cards` use a short heading plus concise detail, and long prose moves to notes or another slide. Keep titles near 32 CJK-equivalent units and individual card, process, timeline, or complex-layout items below roughly 48-56 units.

## Quality Bar

- The first three slides should make the audience care.
- The middle should prove the thesis, not just list information.
- The final slides should make the next action obvious.
- Avoid generic titles like "Background", "Analysis", or "Summary" unless paired with a specific conclusion.
