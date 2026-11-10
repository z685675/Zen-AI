# PPTX story and layout

## Story Architecture

- Infer one internal argument mode before choosing layouts. Use `briefing` for status, decisions, and executive updates; `pyramid` for recommendation-first proposals; `narrative` for change, launches, and persuasive stories; `instructional` for lessons and procedures; and `showcase` for portfolios, products, places, and visual work. The user never needs to name a mode.
- Infer one deck-level composition profile from the occasion, audience, content density, and mood. Use `structured` for reports, analysis, strategy, research, management, and dense decision material; `spatial` for architecture, places, museums, photography, portfolios, and contemplative visual stories; and `kinetic` for launches, festivals, exhibitions, campaigns, keynotes, public art, and energetic live events. Keep the profile coherent across the deck. The user never needs to name it.
- Keep visual style and composition profile independent. An explicit `editorial` or brand style still wins palette and language selection, while the profile changes cover geometry, page chrome, statement placement, image framing, whitespace, and reading path to fit the actual occasion.
- Keep argument mode independent from visual style. A narrative deck can be minimal, editorial, technical, or premium; a visual-style change must not silently change the reasoning order or evidence.
- Build an internal page manifest with semantic role, main takeaway, evidence type, composition family, content density, visual role, and intentional pattern break. Do not expose this engineering vocabulary to the user.
- Select page geometry from content requirements first, then express it through the resolved layout language. Never force every point into cards because a style happens to use colored surfaces.
- Use the dedicated semantic layouts for complex messages: `network` for relationships or ecosystems, `matrix` for four-quadrant decisions, `schedule` for timed programs, and `route` for journeys, visitor paths, or staged spatial movement. Do not flatten these messages into generic cards or a process page.
- For 5+ slides, review the complete storyline before generation: opening tension or decision, evidence sequence, turning point or recommendation, and closing action. Remove pages that repeat the same job.

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
