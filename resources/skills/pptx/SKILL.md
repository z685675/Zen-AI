---
name: pptx
description: Create, edit, analyze, validate, and polish real PowerPoint/PPTX slide decks with mature layouts and quality checks. Use when the user asks to create PPT/PPTX/PowerPoint/slides/slide deck/presentation/演示文稿/幻灯片/汇报/路演/课件, convert content into slides, improve an existing deck, follow the visual style of a supplied PPTX or slide screenshot, extract slide content, or produce a usable presentation file rather than plain text.
---

# PPTX

Create presentation files that are usable, visually structured, and not just title-plus-bullet pages.

## Operating Rules

- Start with the communication goal: audience, setting, decision needed, page count, and tone.
- If the user only gave rough material, create a slide plan or deck spec before generating the file.
- Use `mcp__assistant__create_file` with `format: "pptx"` for the verified `.pptx` draft.
- Use rich slide fields: `title`, `subtitle`, `layout`, `takeaway`, `visual`, `bullets`, `notes`, and `image_asset_id`. Omit `accent` by default so the deck-level visual style controls a coherent palette; set it only when the user explicitly requests a particular slide color or a semantic exception is necessary.
- Treat `visual` as internal design direction only; it is never visible fallback copy. Put user-facing supporting text in `subtitle`, `takeaway`, or `bullets`. For a real local image, pass it in `assets` as `{ id, file_path, alt_text }` and reference its ID with `image_asset_id`; the built-in generator normalizes the image, embeds the media part, and switches to the bounded `image` layout.
- Avoid long paragraphs. Convert content into cards, process steps, comparisons, metrics, summaries, and section dividers.
- Treat each layout as a content contract, not a decorative preference. Choose a layout only when its fields match the contracts below.
- Keep visible labels, helper copy, and fallback text in the deck's language. Never ship English generator placeholders inside an otherwise Chinese deck.
- Do not fake a PPTX by writing text into a `.pptx` extension.

## Story Architecture

- Infer one internal argument mode before choosing layouts. Use `briefing` for status, decisions, and executive updates; `pyramid` for recommendation-first proposals; `narrative` for change, launches, and persuasive stories; `instructional` for lessons and procedures; and `showcase` for portfolios, products, places, and visual work. The user never needs to name a mode.
- Infer one deck-level composition profile from the occasion, audience, content density, and mood. Use `structured` for reports, analysis, strategy, research, management, and dense decision material; `spatial` for architecture, places, museums, photography, portfolios, and contemplative visual stories; and `kinetic` for launches, festivals, exhibitions, campaigns, keynotes, public art, and energetic live events. Keep the profile coherent across the deck. The user never needs to name it.
- Keep visual style and composition profile independent. An explicit `editorial` or brand style still wins palette and language selection, while the profile changes cover geometry, page chrome, statement placement, image framing, whitespace, and reading path to fit the actual occasion.
- Keep argument mode independent from visual style. A narrative deck can be minimal, editorial, technical, or premium; a visual-style change must not silently change the reasoning order or evidence.
- Build an internal page manifest with semantic role, main takeaway, evidence type, composition family, content density, visual role, and intentional pattern break. Do not expose this engineering vocabulary to the user.
- Select page geometry from content requirements first, then express it through the resolved layout language. Never force every point into cards because a style happens to use colored surfaces.
- Use the dedicated semantic layouts for complex messages: `network` for relationships or ecosystems, `matrix` for four-quadrant decisions, `schedule` for timed programs, and `route` for journeys, visitor paths, or staged spatial movement. Do not flatten these messages into generic cards or a process page.
- For 5+ slides, review the complete storyline before generation: opening tension or decision, evidence sequence, turning point or recommendation, and closing action. Remove pages that repeat the same job.

## Reference-Style Workflow

- Treat natural requests such as "按这份 PPT 的风格生成", "参考第 6 页的感觉", or "做成这张截图的感觉" as an approximate reference-style request. The user does not need to know `pptx_style_reference`, `adaptive-design`, or a Skill name. Calling a file a "模板" in an otherwise style-oriented request does not by itself require mechanical page cloning. Use native reuse only when the user asks to retain masters, layouts, placeholders, editable source objects, or selected source pages.
- Pass the authorized local reference through `pptx_style_reference: { file_path, slide_number? }` when calling `mcp__assistant__create_file`. Use `slide_number` when one page is the intended exemplar; omit it when the whole deck should inform the aggregate profile.
- A PPTX reference leads palette, theme fonts, light/dark rhythm, media density, chart cadence, layout diversity, page archetypes, and the closest supported Zen AI layout language. `slide_number` may emphasize one page's palette and typography, but it must never replace the whole deck's light/dark and image/report rhythm. The source PPTX is read-only and the output must use a different path.
- A screenshot reference may inherit palette, composition bias, spatial rhythm, active-content occupancy, edge/texture character, approximate image treatment, and broad visual direction. These signals must influence geometry and whitespace, not only colors. Do not claim that fonts, icons, masters, exact coordinates, or pixel geometry were recovered. Do not embed the screenshot as slide content unless the user separately asks for it.
- Omit `visual_style` whenever `pptx_style_reference` is present. Do not infer a style from the new topic and pass it alongside the reference: topic classification such as `research` or `healthcare` must not replace the reference deck's layout language. An explicit non-`auto` `style_mode` and real user-supplied `brand_theme` colors may still refine the result.
- Inspect the reference composition before building the deck spec. When pictures appear on many reference pages, gather or create semantically appropriate images for the new topic, pass them through `assets`, and assign `image_asset_id` across a comparable share of output slides. Use genuinely distinct media: do not assign one or two illustrations repeatedly across a photo-led deck, do not alias the same file under different asset IDs, and keep any single image at or below half of the image-led pages. Never reuse unrelated source photos merely to satisfy image density, and never put "延续参考稿图片风格" in `visual` as a substitute for an embedded image.
- For brand, culture, showcase, event, travel, place, product-launch, and portfolio decks without a reference, plan real topic-relevant visual evidence on a meaningful share of slides whenever images would materially carry the story. Prefer distinct photos, product states, places, people, artifacts, diagrams, or generated visuals over decorative rectangles. If usable assets are genuinely unavailable, keep a graceful typographic fallback and state the limitation; do not invent a local path or claim that `visual` prose is an image.
- Preserve evidence rhythm as well as color: include chart-oriented pages when charts are meaningful in the reference, vary semantic layouts at a comparable cadence, and retain a similar balance of dense/sparse and light/dark pages. Check `pptx-reference-composition` for PPTX references and `pptx-reference-design-language` for screenshot references before reporting success.
- Use this workflow for visual-language inheritance and content-fit compositions. When the source is supplied through `pptx_template` but several required new-topic pages do not fit its page inventory, select `mode: "adaptive-design"`; it applies the same reference analysis and similarity gate without forcing source geometry. When the user asks to edit existing pages or keep native masters/layouts, use `edit-copy` or `new-deck` instead.

## Native PPTX Template Workflow

- Treat a terse request that names a source PPTX template and a new topic as complete. Do not ask the user to specify master/layout preservation, page mapping, image replacement, source protection, output naming, validation, or retry behavior.
- For every new-topic template request, call `mcp__assistant__inspect_pptx_template` before writing the outline. This is an internal planning step, not a question for the user. Read `design_language`, `deck_targets`, and each page's archetype, arrangement, `item_capacity`, image/chart requirements, `content_density`, and body-text target range.
- Build the new storyline independently and list the semantic role required by each page. Choose the execution strategy internally:
  - `edit-copy`: selected-page edits where the rest of the source must remain unchanged.
  - `new-deck`: most required pages have compatible source archetypes and native masters/layouts are part of the requested value.
  - `adaptive-design`: the source is mainly admired for its visual language, or several required page semantics would be distorted by its fixed geometry.
- In `adaptive-design`, preserve palette strategy, typography scale, alignment, shape language, information density, image treatment, and page rhythm through content-fit Zen AI layouts. It is not exact package reuse and must not be described as such.
- Treat source elements as either visual identity or semantic content. Background fields, recurring rules, folios, brand markers, and stable decorative motifs normally remain identity; old titles, labels, numbers, charts, photos, and topic icons are replaceable content. When uncertain, preserve the visual grammar but replace the topic meaning.
- Author the new topic's argument and evidence first, then map that story to compatible source pages. Never preserve the source storyline, labels, numbers, chart data, icons, or image meaning merely because their Shapes exist. Do not map pages sequentially when another source page fits the new content better.
- Match repeated layouts deliberately: a three-column page needs three coherent items; a four-card page needs up to four; a list must stay within its capacity. Use `heading | detail` for cards/lists and `label:value` for native charts or metrics. A four-digit year such as `2027 行动` is a heading, not a metric.
- Match information density as well as item count. For dense source pages, each repeated item should normally contain a conclusion plus evidence and an implication/action. Stay between `target_body_text_units_min` and `target_body_text_units_max`; remap or split before shrinking text. The runtime blocks severely underfilled dense pages and tells the assistant to enrich or remap internally.
- Automatically inspect the whole source deck, choose the strategy above, infer the audience, storyline, slide count, output name, and any required source-page mapping, replace off-topic photos with distinct topic-relevant assets, keep the source read-only, validate the finished PPTX, and retry correctable failures internally before reporting completion.

- Detect natural requests such as "修改这份 PPT 的第 6 页", "沿用这个 PPT 模板生成", "保持原母版和版式", or "从这份 PPT 挑几页原样组合". The user does not need to know `pptx_template`.
- Pass the authorized source through `pptx_template: { file_path, mode }`. Never combine `pptx_template` with `pptx_style_reference`, and always write to a path different from the source.
- Use `mode: "edit-copy"` to clone the complete source package and edit selected pages in the output copy. Set each slide's `target_slide_number`, or use a top-level `target_slide_number` for one update. Unedited slide XML remains byte-for-byte unchanged.
- Use `mode: "new-deck"` to build a new slide sequence from source pages while preserving native masters, layouts, theme, geometry, charts, and slide relationships. Set `template_slide_number` per output slide or a top-level `source_slide_number` as the default.
- Use `mode: "adaptive-design"` when content fit matters more than native geometry. The source remains read-only; the result reports the extracted design language, reference-composition similarity, and `exact_package_reuse: false`.
- To replace a source page's main photo without losing its crop or bounds, pass a local topic-relevant image through `assets` and assign its ID as that slide's `image_asset_id`. The native engine replaces the largest picture shape on that source page. Do not assign an image to a page with no picture shape, and do not leave semantically unrelated source photos in a new-topic deck.
- Set `preserve_content: true` on a `new-deck` slide when the selected source page must be copied without rewriting any slide object. Do not combine that output page with `shape_replacements`.
- Standard title, subtitle, and body placeholders are mapped first. Named text shapes and conservative geometry fallback are used only when the source lacks standard placeholders. Use `shape_replacements` for exact text edits by `shape_name`, `find_text`, or both.
- Native-template text edits preserve each matched shape's geometry and styling and add bounded shrink-to-fit. Existing media and unsupported objects remain in the package; do not recreate them with a generic layout.
- Before delivery, reject and retry any result with missing first items, orphan empty cards, source-topic text or semantic icons, unchanged source chart data, clipped text, or a PowerPoint repair prompt. When a source layout cannot fit safely, remap to a compatible page or create a continuation page instead of truncating content.
- Current boundary: one output deck uses either native page reuse or adaptive generated layouts; it does not mix independently generated pages into the source OOXML package. Arbitrary image-placeholder replacement, SmartArt mutation, animation editing, and screenshot-to-editable-object reconstruction remain unsupported. A source PPTX page can be preserved exactly; a screenshot can only guide an approximate new page. Never use the screenshot as a full-slide background and call it an editable clone.

## Shared Visual Style System

- The user never needs to know the Skill name or a style ID. Infer presentation intent from the natural-language request, audience, title, content, and `document_type`.
- For an ordinary request, pass a specific `document_type` and omit `visual_style`; `create_file` resolves and reports the style automatically. Use explicit `visual_style` only when the user asks for a direction or the inferred direction would clearly be wrong.
- Use `style_mode: "auto"` unless the user asks for `light`, `dark`, or grayscale `print`. Use `brand_theme` only with real supplied brand colors; do not invent brand hex values.
- Brand colors override the palette but preserve the selected layout language. `custom-brand` is appropriate when brand colors are the primary direction.
- Keep one visual language across the deck. Do not rotate unrelated blue, green, amber, and purple accents page by page. An explicit per-slide `accent` overrides the automatic deck palette and must be exceptional.

Available visual styles:

- Formal and business: `executive` (high-level decision), `corporate` (general company), `consulting` (strategy), `finance` (investment), `government` (public sector), `legal` (compliance).
- Knowledge and product: `academic` (thesis), `research` (white paper), `technology` (technical/future), `product` (product design), `data` (analytics).
- Growth and communication: `startup` (fundraising), `sales` (proposal), `brand` (campaign), `editorial` (magazine/story).
- Education and human topics: `education`, `children`, `training`, `healthcare`, `sustainability`, `culture`, `warm`.
- Expressive and neutral: `premium`, `creative`, `bold`, `minimal-light`, `minimal-dark`, `monochrome`, `custom-brand`.

The PPTX renderer translates these styles into coordinated cover composition, page chrome, information hierarchy, whitespace, shape language, typography, background, surface, text, line, and three related accent tones. Style selection must change geometry and reading order as well as color. A palette-only variation is not a successful style change.

Within the layout languages, the renderer also applies `structured`, `spatial`, or `kinetic` composition profiles. This is how two decks can share a mature editorial, brand, playful, organic, or minimal language without sharing the same cover, statement, image, and recurring-page skeleton. Do not force a launch into a report grid or make a formal annual report inherit festival-like motion merely because both topics mention culture.

The renderer resolves the public styles into 14 semantic layout languages, not interchangeable skins:

- `classic`: narrative lead-and-support composition, numbered navigation, open statements, and conventional evidence charts.
- `executive`: decision rails, structured evidence rows, restrained rules, and scan-friendly status hierarchy.
- `consulting`: numbered typographic grids, asymmetric statements, ranked dot plots, and concise thesis-first sequencing.
- `formal`: disciplined report rules, archival image plates, aligned evidence rails, and conservative information density.
- `technical`: framed modules, telemetry, signal bars, instrument grids, and inspectable image viewports.
- `product`: task canvases, focus markers, annotated product imagery, lollipop charts, and workflow-oriented sequencing.
- `data`: analytical panels, source-versus-observation image layouts, instrument charts, and dense but bounded structure.
- `bold`: large proportional color fields, manifesto statements, high contrast, and strong scale changes.
- `brand`: off-grid story blocks, campaign imagery, color-field charts, and distinctive branded rhythm.
- `editorial`: folios, image spreads, typographic captions, ranked evidence, and magazine-like pacing.
- `playful`: activity lanes, staggered sequences, friendly color tiles, bubble charts, and energetic hierarchy.
- `organic`: soft narrative bands, portrait-led imagery, alternating rhythm, and human-centered evidence.
- `premium`: gallery imagery, fine rules, restrained legends, luxurious whitespace, and typography-led ranking.
- `minimal`: sparse image planes, thin markers, reduced annotation, ranked typography, and deliberate whitespace.

Each language must materially change process, timeline, chart, and image composition as well as cover and content pages. A palette-only variation is a failed generation.

Do not repeat the same title-plus-rectangle skeleton across styles. Cards are a content contract for parallel ideas, not the universal page container. Across a normal deck, vary open rows, split statements, comparison fields, process nodes, timelines, metrics, charts, quotes, images, and section breaks; do not use boxed cards on consecutive pages unless the pages form an intentional series.

## Runtime Contract

- Run bundled scripts with `mcp__assistant__python_execute` using the script's actual installed Skill path and `arguments`; do not assume the workspace root contains `scripts/`.
- On Windows, read Skill Markdown or JSON with UTF-8 explicitly, for example `Get-Content -Raw -Encoding utf8`. Never infer instructions from mojibake output.
- Do not probe `python3`, `py`, Conda, or the user's system Python.
- Do not install packages from this Skill. Its bundled scripts use the managed standard library.
- If managed Python is not ready, still create the PPTX with `mcp__assistant__create_file`, skip only the unavailable script check, and report one environment error without retrying other runtimes.

## Bundled Resources

- Read `references/visual-quality.md` when the user asks for a polished, mature, "good-looking", presentation-ready, commercial, pitch, report, or executive deck.
- Use `scripts/validate_deck_spec.py` before creating decks with 5+ slides, high-stakes decks, or any deck where visual quality matters.
- Run `scripts/validate_pptx.py --strict-visual` on every generated or modified PPTX before reporting success. A nonzero exit means the file is not deliverable.
- Start from `assets/deck-templates/` when the deck matches a common pattern:
  - `executive-report.json` for leadership reports and decision memos.
  - `product-proposal.json` for product plans and internal proposals.
  - `pitch-deck.json` for investor, sales, or business pitches.
  - `training-course.json` for lessons, training, and courseware.
- Use `scripts/prepare_deck_template.py` to list templates or prepare an editable template spec.
- If deck-spec validation fails, revise the spec before generation. Do not generate a file from a weak spec.

## Performance Policy

- Use a one-pass normal path: plan once, generate one final PPTX, then validate once. Do not create separate draft and final files unless the user asked for both.
- For simple decks with up to 4 slides and no polished/high-stakes requirement, skip strict deck-spec validation and generate directly from a compact in-memory plan.
- For decks with 5+ slides or presentation-ready requirements, normalize and validate the deck spec once before generation; do not repeat unchanged checks.
- After a required render check, use the rendered result as a repair decision: revise the affected slide's content density, composition, or asset placement once, then regenerate and revalidate. Do not retry unchanged input and do not redesign unaffected pages merely because one page failed.
- If package validation reports only deterministic OOXML defects handled by `repair_duplicate_shape_ids.py`, repair into a new path once and revalidate. Do not ask the model to regenerate unchanged content.
- Regenerate only for content, layout, missing-asset, or unsupported-feature problems that a package repair cannot solve.
- When revising a generated deck, prefer updating its deck spec and regenerating it through `mcp__assistant__create_file`. When the user explicitly needs the existing PPTX's native template or selected-page edit, use `pptx_template`; do not use an ad hoc `python-pptx` patch when either stable path can express the change.
- Prepare independent visual assets in parallel and generate only visuals that have a clear role in the slide argument.
- Use `render_validation: "auto"` for routine generation. For polished, high-stakes, image-bearing, or custom decks, use `render_validation: "required"`; this uses headless LibreOffice when available and can use installed Microsoft PowerPoint on Windows to export a validation PDF. Do not claim rendered validation passed when the tool reports `unavailable`.

## Deck Workflow

1. Define audience, goal, thesis, desired impression, constraints, and whether a supplied screenshot/PPTX is an approximate style reference or a native template/edit source.
2. Build a JSON deck spec with slide fields compatible with `create_file`.
3. If the task matches a built-in template, copy the closest JSON from `assets/deck-templates/` and adapt titles, takeaways, bullets, and visual cues.
   - To prepare a template, call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/prepare_deck_template.py"` and `arguments: ["executive-report", "--title", "Deck title", "--out", "deck.json"]`.

4. Run the bundled validator:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/validate_deck_spec.py"` and `arguments: ["deck.json", "--strict"]`.

5. Fix errors and meaningful warnings: generic titles, dense bullets, repeated layouts, missing takeaways, weak visual cues.
6. Call `mcp__assistant__create_file` with the normalized `format`, `title`, `document_type`, and `slides`. Normally omit `visual_style` and all slide `accent` fields so automatic styling can work. For an approximate reference request, pass `pptx_style_reference` and always omit `visual_style`; for an exact PPTX template/edit request, pass `pptx_template` and the relevant page mapping fields. Pass local images through `assets` and matching `image_asset_id`; in native-template mode this replaces the mapped source slide's dominant picture while retaining its geometry. Use `render_validation: "required"` for presentation-ready delivery.
7. Validate the generated OOXML package and expected slide count:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/validate_pptx.py"` and `arguments: ["output.pptx", "--expected-slides", "8", "--strict-visual"]`.

8. If validation fails with a supported deterministic OOXML defect, repair once into a new file and revalidate. For content or layout failures, fix the spec or generator and regenerate once. Never retry unchanged input.
9. Verify the `.pptx` exists, is nonzero size, and has the expected slide count. For high-stakes compatibility testing, also verify that PowerPoint opens it without a repair prompt.

## PPTX Integrity Guardrails

- A `.pptx` is a ZIP-based OOXML package. Valid XML alone is insufficient: relationship targets, relationship IDs, slide IDs, and every slide's `p:cNvPr` shape IDs must also be valid and unique.
- Every slide must have exactly one internal `slideLayout` relationship, and every referenced slide layout must have exactly one `slideMaster` relationship. Missing or duplicate layout/master relationships are blocking generator defects.
- Every internal relationship target and every `[Content_Types].xml` override target must exist in the package. Never deliver a deck with dangling or orphaned parts.
- Treat non-web external relationships, linked media, executable actions, empty slides, Unicode replacement characters, and visible Markdown authoring markers as blocking. Ordinary reviewed web hyperlinks may remain as warnings.
- When an image was requested, require `embedded-media` in the `create_file` verification result and require `ppt/media/*`, an internal image relationship, and a `p:pic` shape. A text placeholder or `visual` field is not an embedded image.
- When `pptx_style_reference` is used, require `pptx-reference-composition` in the verification result. A similarity score below 70, severe image-ratio loss, collapsed layout diversity, wrong light/dark rhythm, or insufficient unique media is blocking; revise and regenerate instead of delivering the file with a warning.
- Every theme's major and minor font collections must contain `latin`, `ea`, and `cs`. Each `fillStyleLst`, `lnStyleLst`, `effectStyleLst`, and `bgFillStyleLst` must contain at least three styles, and every slide master must include `p:txStyles`.
- When using PptxGenJS, do not use `defineSlideMaster({ slideNumber: ... })` for shape-heavy decks. Some versions emit a fixed slide-number placeholder ID that can collide with the slide's 25th shape. Add visible page numbers with ordinary `slide.addText()` calls instead.
- Never pass negative `w` or `h` values to PptxGenJS shapes or lines. Normalize endpoints first (`x = min(x1, x2)`, `w = abs(x2 - x1)`, and the same for `y`/`h`) and use `flipH`/`flipV` only when direction must be preserved. Negative DrawingML `a:ext` values can make PowerPoint report file corruption even when the ZIP and XML parse successfully.
- Keep `ppt/presentation.xml` children in schema order. In particular, `notesMasterIdLst` must precede `sldIdLst` when both are present.
- Give each notes master its own theme part. Do not point `ppt/notesMasters/_rels/notesMaster*.xml.rels` at the same `ppt/theme/themeN.xml` used by the presentation or slide master; PowerPoint can treat that shared target as corrupt even when Open XML schema validation passes.
- If a custom generator is necessary for advanced visual quality, it is allowed only when its output passes `validate_pptx.py --strict-visual` and a rendered-slide review.
- Generated text inside cards, charts, timelines, labels, and other bounded regions must use `a:normAutofit` or an equivalent shrink-to-fit policy. Never use `a:spAutoFit` there because it expands the shape over neighboring content.
- Never use `vertOverflow="ellipsis"` on generated or replaced text. Ellipsis can hide final characters even when the complete copy remains in the file. Use bounded `a:normAutofit`, shorten the copy, select a roomier layout, or add a continuation slide instead.
- Every visible text run created or replaced by a custom generator must carry an explicit font size. Do not rely on inherited theme or paragraph defaults for custom edits.
- A custom `python-pptx` edit must preserve the original shape bounds, set explicit run sizes, and produce bounded shrink-to-fit DrawingML. If it cannot do all three, regenerate that slide or the deck through `mcp__assistant__create_file` instead.
- Missing layout/master relationships, incomplete themes, or missing master text styles are not repairable presentation content. Regenerate through `mcp__assistant__create_file`; do not delete parts or ask PowerPoint to repair the file.
- `repair_duplicate_shape_ids.py` may recover duplicate shape IDs, negative shape extents, presentation child ordering, and shared notes-master themes into a new path, but it is not a substitute for fixing and rerunning the generator.
- Never overwrite the only copy of a user's presentation while repairing or validating it.

## Layout Guidance

Use varied layouts across the deck:

- `cover`: title, subtitle, context, date or speaker when known
- `agenda`: roadmap or section list
- `section`: chapter divider
- `insight`: one conclusion plus evidence
- `cards`: 3-4 parallel points
- `process`: workflow, timeline, or staged plan
- `timeline`: milestones, roadmap, or staged delivery over time
- `network`: 3-6 actors, systems, or nodes connected to a shared mechanism
- `matrix`: exactly four quadrants for prioritization or two-axis decisions
- `schedule`: up to 6 timed sessions or program moments
- `route`: 3-6 stops in a journey, visitor path, service path, or spatial sequence
- `comparison`: before/after, options, competitors, pros/cons
- `metric`: important numbers and implications
- `chart`: compact bar-chart style data comparison
- `image`: a bounded media region plus concise supporting evidence; requires `image_asset_id`
- `quote`: customer proof, strong viewpoint, or memorable quote
- `summary`: conclusions and next actions

## Content-to-Layout Contracts

Use CJK-equivalent length when judging density: one Chinese character counts as roughly one unit and two Latin letters or digits count as roughly one unit.

- `metric`: 2-3 real numeric signals only. Write each bullet as `label: value | implication`, keep the value under 14 units, and include a number, percentage, currency, ratio, or duration. Use `cards` or `insight` for concepts and long statements.
- `timeline`: 3-5 milestones. Write each bullet as `period | milestone: concise detail`; keep each complete milestone under 56 units. Use short nodes for compact milestones and expect a wide-row roadmap for detailed milestones.
- `network`: 3-6 nodes. Write each bullet as `node | concise detail`; use the takeaway as the shared hub or governing mechanism.
- `matrix`: exactly four quadrants. Write each bullet as `quadrant | concise implication`; state the two decision dimensions in the title, subtitle, or takeaway.
- `schedule`: up to 6 sessions. Write each bullet as `time | event: concise detail` and keep chronology explicit.
- `route`: 3-6 stops. Write each bullet as `stop | milestone: concise detail`; use this for a journey or spatial path, not merely dates.
- `process`: 3-5 verb-led steps. Write each bullet as `step: concise detail` and keep it under 48 units.
- `cards`: 3-4 parallel ideas. Put the short card heading before `:` and keep each complete card under 48 units.
- `chart`: up to 6 rows in `label | value` or `label: value` form. Values must contain a number.
- `comparison`: pair comparable dimensions and keep each point under 52 units.
- `takeaway`: one sentence, normally under 52 units. If it needs a paragraph, move the detail to speaker notes or another slide.
- Slide titles should normally stay under 32 units. Rewrite a long label as a sharper conclusion instead of relying on tiny type.
- Never place raw prose into `metric`, narrow timeline nodes, or compact process boxes. Change the layout before reducing body text below a presentation-readable size.

## Quality Bar

- Every slide title should be a message, not a label.
- Each content slide should have one job and one main takeaway.
- Adjacent slides should not repeat the same layout unless intentionally forming a series.
- The deck should have a restrained palette, consistent typography, and enough whitespace.
- Text must stay inside its intended shape. Automatic shrink is a last guardrail, not permission to overfill a slide; revise the content or layout when text would become uncomfortably small.
- Remove all placeholder copy such as `Key insight`, `Key message`, `Draft presentation`, or `Translate this number into a decision` before delivery.
- The final response should include the file path and a short deck structure summary.
- Never report completion when strict package validation fails, a rendered slide shows clipping/overlap, or PowerPoint requires repair on open.
