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
- Treat each layout as a content contract, not a decorative preference. Choose a layout only when its fields match `references/story-and-layout.md`.
- In the new assistant, generated slide bodies are checked for supplied visible text before writing; speaker notes and `visual` do not satisfy this check. If content is missing, split it across continuation slides or choose a fitting layout, rather than retrying the unchanged input or deleting requested points. Native-template modes retain their separate mapping validation.
- Keep visible labels, helper copy, and fallback text in the deck's language. Never ship English generator placeholders inside an otherwise Chinese deck.
- Do not fake a PPTX by writing text into a `.pptx` extension.

## Planning and layout references

- Choose page structure from the message and required visible content. Read `references/story-and-layout.md` when selecting or changing layouts, story architecture, or content density; it defines each supported layout's field/capacity contract.
- For a supplied PPTX, screenshot, or template, read `references/reference-workflows.md` before generation to choose style inheritance versus native editable-page reuse.
- Read `references/visual-styles.md` when choosing an explicit style, composition profile, or brand treatment.
- Load only the relevant guidance; complex/reference tasks still require the full applicable workflow.

## Runtime Contract

- Run bundled scripts with `mcp__assistant__python_execute` using the script's actual installed Skill path and `arguments`; do not assume the workspace root contains `scripts/`. Relative file arguments resolve from the authorized task workspace, not the Skill script directory. Preserve supplied absolute paths.
- On Windows, read Skill Markdown or JSON with UTF-8 explicitly, for example `Get-Content -Raw -Encoding utf8`. Never infer instructions from mojibake output.
- Do not probe `python3`, `py`, Conda, or the user's system Python.
- Do not install packages from this Skill. Its bundled scripts use the managed standard library.
- If managed Python is not ready, still create the PPTX with `mcp__assistant__create_file`, skip only the unavailable script check, and report one environment error without retrying other runtimes.
- If an advanced edit or approved external workflow produces the final PPTX outside `mcp__assistant__create_file`, call `mcp__assistant__present_files` with the verified final path before replying.

## Bundled Resources

- Read `references/visual-quality.md` when the user asks for a polished, mature, "good-looking", presentation-ready, commercial, pitch, report, or executive deck.
- Use `scripts/validate_deck_spec.py` before creating decks with 5+ slides, high-stakes decks, or any deck where visual quality matters.
- Reuse completed generator checks. Run `scripts/validate_pptx.py --strict-visual` for unverified visual/feature requirements and use `mcp__assistant__validate_file` after edits to the working copy. A failed required check means the file is not deliverable.
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

## Quality Bar

- Every slide title should be a message, not a label.
- Each content slide should have one job and one main takeaway.
- Adjacent slides should not repeat the same layout unless intentionally forming a series.
- The deck should have a restrained palette, consistent typography, and enough whitespace.
- Text must stay inside its intended shape. Automatic shrink is a last guardrail, not permission to overfill a slide; revise the content or layout when text would become uncomfortably small.
- Remove all placeholder copy such as `Key insight`, `Key message`, `Draft presentation`, or `Translate this number into a decision` before delivery.
- The final response should include the file path and a short deck structure summary.
- Never report completion when strict package validation fails, a rendered slide shows clipping/overlap, or PowerPoint requires repair on open.

## Delivery contract

Treat explicit page, slide, worksheet and file counts as hard requirements. Verify actual outputs using the format validator and rendered pages where applicable; do not infer a Word page count from source text. Check requested formulas and final-page text, and distinguish obsolete values from the final decision. Deliver only existing final paths, excluding temporary previews and replaced files. Reuse validation already completed by the generator; add checks only for unverified requirements.
