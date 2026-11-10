# PPTX visual styles

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
