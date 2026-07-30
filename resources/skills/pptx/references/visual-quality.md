# PPTX Visual Quality

Use this reference when the user asks for a polished, mature, presentation-ready PPTX.

## Deck-Level Standards

- Start from a clear audience decision: inform, persuade, align, train, sell, or report.
- Infer the argument mode separately from the visual language: briefing, pyramid, narrative, instructional, or showcase. Do not let a color/style decision rewrite the deck's reasoning structure.
- Use one thesis for the deck and one takeaway per content slide.
- Vary slide rhythm: cover, agenda, section divider, insight, cards, comparison, process, timeline, network, matrix, schedule, route, metric, chart, image, quote, summary.
- Prefer conclusion titles: "自动化入口应先服务个人高频场景" is stronger than "功能规划".
- Keep the deck inspectable: short titles, compact bullets, visible hierarchy, and obvious next steps.

## Slide Density

- Cover: title, subtitle, 1 takeaway, up to 3 tags.
- Insight: 1 takeaway plus 3-5 evidence points.
- Cards: 3-4 parallel ideas only.
- Process: 3-5 stages with verbs.
- Timeline: 3-5 milestones with clear sequencing.
- Comparison: two sides with matched dimensions.
- Metric: up to 3 metrics, each with implication.
- Chart: up to 6 data points with label:value bullets.
- Quote: 1 strong sentence plus optional attribution.
- Summary: decisions, actions, owners, or next steps.

## Text-Box Safety

- Match content semantics to the layout before adjusting font size. A sentence is not a metric merely because it contains a colon.
- Keep titles near 32 CJK-equivalent units, takeaway bands near 52, cards and process steps near 48, timeline milestones near 56, and comparison rows near 52.
- Use `label: value | implication` for metrics. The value must be compact and numeric; otherwise use cards or an insight layout.
- Use `period | milestone: detail` for timelines. Detailed milestones should use wide stacked rows instead of narrow alternating cards.
- Prefer two levels inside cards: a short heading and concise supporting detail. Do not make the full paragraph bold.
- Use `node | detail` for networks, four `quadrant | detail` rows for matrices, `time | event: detail` for schedules, and `stop | milestone: detail` for routes. These are semantic structures, not alternate card skins.
- Require text boxes to use shrink-to-fit or an equivalent bounded overflow policy, while keeping body text presentation-readable. In DrawingML, bounded generated regions must use `a:normAutofit`, never `a:spAutoFit`.
- Require every visible text run written by a custom generator or edit script to have an explicit font size. Inherited run sizes are too fragile for deterministic layout validation.
- Treat visible fallback or placeholder text in the wrong language as a blocking defect.

## Visual Direction

- Infer a deck-level visual style from audience, subject, document type, and requested mood. Business blue is one valid answer, not the default answer to every topic.
- Infer a coherent composition profile separately: `structured` for reports and dense decisions, `spatial` for place/architecture/portfolio stories, and `kinetic` for launches, festivals, exhibitions, campaigns, and live events. The profile must change cover geometry, recurring chrome, statement placement, image framing, and reading path without replacing the selected visual language.
- Use related palette tones across slides. Do not auto-assign a different named `accent` to every page; explicit accents bypass the deck-level palette.
- Let the layout language match the subject: formal reports can use disciplined rails and tables, editorial stories can use stronger typography and asymmetric markers, education can be more playful, healthcare and sustainability can feel organic, and premium or technology decks can use controlled dark modes.
- Treat a style change as a composition change. The cover geometry, title zone, information hierarchy, whitespace distribution, recurring markers, shape vocabulary, and reading path must visibly differ; changing only fills, lines, or font colors fails review.
- Keep `corporate` as a neutral but designed language: narrative lead-and-support pages, numbered rows, open statements, and typographic metrics. Do not let an unspecified style fall back to a grid of equal rectangles.
- Use containers only when they express grouping or comparison. Prefer rules, spacing, scale, alignment, circles, open nodes, or a single dominant field when several separate boxes add no meaning.
- Avoid decorative gradients unless they support hierarchy.
- Use white space and grouping rather than filling every area.
- Use tables only when comparison matters; otherwise use cards or rows.
- Never turn a long document into one bullet slide per paragraph.
- For culture, brand, showcase, event, place, travel, portfolio, and product-launch stories, plan real topic-relevant images on multiple slides when visual evidence materially improves the narrative. `visual` text is only a design note. Use `assets` and `image_asset_id` for actual media; preserve a usable typographic fallback when no trustworthy asset is available.

## Reference Fidelity

- Distinguish visual-language inheritance from template cloning. A successful reference-guided deck can carry the source's palette, typographic mood, density, geometry family, and reading rhythm without reproducing every coordinate.
- For a supplied PPTX, select a representative `slide_number` when one page best expresses the requested direction. Aggregate the deck only when the user intends a deck-level average.
- For a screenshot, use corner-aware background detection plus active-content occupancy, visual centroid, left/right and top/bottom weight, edge density, texture score, approximate photographic coverage, composition bias, and whitespace rhythm. Resolve the closest supported layout language from those signals, not palette alone. Screenshot analysis remains approximate and cannot reliably recover theme fonts, masters, hidden grids, animation, or editable source shapes.
- The reference profile leads layout language. Omit `visual_style` in a reference-guided call so a new topic classification cannot silently replace the source composition; an explicit requested light/dark mode or real supplied brand color may still refine it.
- Never overwrite the reference file. Use `pptx_style_reference` only for approximate visual-language inheritance; use `pptx_template` when exact native PPTX structures must be retained.
- Judge reference quality by overall visual resemblance and content usability, not by color alone. The result should reflect similar hierarchy, whitespace, shape vocabulary, reading path, media/chart cadence, light/dark rhythm, text density, and layout diversity while remaining stable for the new content.
- An image-heavy reference requires topic-relevant new images. Never reuse unrelated source photos just to match coverage, and never treat `visual` prose as evidence that an image exists. A zero-picture result must fail reference-composition validation.

## Adaptive Design Language

- Extract the source's palette strategy, contrast, typography scale, alignment, shape language, information density, image treatment, and page rhythm before planning content.
- Preserve the reason the source looks good, not its old topic or page sequence. A source card grid may become open rows, a comparison, or a new chart when the new message requires it, while keeping the same typographic hierarchy and visual vocabulary.
- Choose native `new-deck` only when the new storyline has compatible source-page archetypes. Choose `adaptive-design` when multiple important pages would otherwise be forced into the wrong geometry.
- `adaptive-design` is reference-guided generation, not native package reuse. It must report `exact_package_reuse: false` and still pass reference-composition similarity.
- Use the inspected density range as a content contract. Dense cards should carry conclusion, evidence, and implication/action; sparse statement pages should remain intentionally sparse. Do not solve underfilled pages by enlarging empty rectangles or solve overfilled pages by shrinking text below presentation size.
- Keep an internal page manifest containing semantic role, selected composition, content density, visual or image role, and mapping reason. The user never needs to write this manifest.
- Classify source elements conceptually as fixed visual identity or replaceable semantic content. Preserve recurring decoration, rhythm, and geometry vocabulary; replace source-topic copy, data, photos, and semantic icons.

## Rhythm And Diversity

- For 6-8 slides, use at least 4 distinct layout types; for 9-12 slides use at least 5; for 13 or more use at least 6 unless a deliberate repeated series is part of the design.
- Use at least three composition families in an 8-page deck and four in a 12-page deck: narrative, evidence, structured comparison, sequence, and open statement/action.
- No ordinary layout should dominate more than roughly 45% of content slides. Do not repeat the same composition family for three pages unless the pages form an intentional sequence.
- Treat pictures as evidence, context, product proof, or emotional framing. Decide the slot role and aspect ratio before selecting or generating the image.

## Native Template Fidelity

- `edit-copy` must preserve the complete source package and leave every unedited slide part byte-for-byte unchanged. The output path must differ from the source path.
- `new-deck` must reuse the selected source pages' masters, layouts, theme, relationships, charts, and media. Reusing one source page more than once must create independent output slide parts.
- Use `preserve_content: true` for a render-preserving page clone. Its source slide XML must not be rewritten, and it cannot also receive `shape_replacements`.
- Standard PowerPoint title, subtitle, and body placeholders take priority over shape-name and geometry fallback. Text edits must preserve shape bounds and styling and use bounded autofit.
- Exact text replacement must match by shape name, existing text, or both. Unmatched content must produce a warning rather than being injected into an unrelated shape.
- Do not call a screenshot an editable or pixel-level clone. Screenshot references cannot recover hidden masters, object structure, charts, icons, animation, or exact fonts. Never hide this limitation by placing the screenshot as a full-slide background.
- Native image-placeholder replacement, SmartArt mutation, and animation editing remain unsupported and must fail clearly instead of preserving the old object while reporting success.

## Preflight Checklist

- The first three slides answer: why now, what matters, what will be decided.
- Every slide title can be read as a sentence.
- Adjacent slides do not repeat the same layout unless they are a deliberate series.
- At least one of every three content slides changes the dominant composition pattern, not merely the accent tone.
- A second visual style applied to the same deck would produce different geometry and reading order, not the same XML skeleton with different colors.
- A reference-guided deck reports whether the source was a PPTX or image, which slide was analyzed, and the confidence/limitations of the inherited profile.
- A PPTX reference result includes `pptx-reference-composition`, similarity score/level, and reference/output picture, chart, layout-diversity, and dark-page ratios. Low similarity and severe cadence warnings must be revised before delivery.
- A native-template result reports mode, source/output slide counts, edited/cloned pages, template pages, and preserved master/layout/media counts.
- Dense source material is compressed into a decision, a contrast, a process, or a metric.
- Every text box remains within its shape without clipping, overlap, ellipsis substitution, or text smaller than a comfortable presentation size.
- Run `scripts/validate_deck_spec.py` for decks with 5+ slides or high-stakes output.
- After generation or modification, run `scripts/validate_pptx.py --strict-visual` and treat expanding text boxes, ellipsis overflow, missing explicit run sizes, duplicate shape IDs, negative shape extents, invalid presentation child ordering, shared notes-master themes, broken relationships, malformed XML, CRC failures, or slide-count mismatches as blocking errors.
- For presentation-ready output, call `create_file` with `render_validation: "required"`. Inspect its rendered-page result for clipping, overlap, unreadably small text, displaced shapes, blank pages, and edge content. OOXML package validity alone cannot prove visual correctness.
- When a rendered page fails, repair the page-level cause once: reduce or split content, select a better composition, adjust image role, or regenerate that page/deck spec. Never repeat identical input or globally simplify a good deck because one page is weak.
- Review rendered density outliers and vertical-balance warnings. An interior page that is far sparser than the deck median or leaves most of the lower canvas unused must be confirmed as an intentional section/statement page or redesigned.
- Local images must use the `assets` plus `image_asset_id` contract and the bounded `image` layout. Verify the media part, internal relationship, `p:pic` shape, alt text, and rendered placement; never substitute a textual visual cue for requested evidence.
- Open the final file without a PowerPoint repair prompt before calling it deliverable.
