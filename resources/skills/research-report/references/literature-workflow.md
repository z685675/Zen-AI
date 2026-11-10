# Efficient literature research

Use this reference when the agreed question requires scholarly evidence or a
literature review. General Deep Research tasks use the research-report workflow;
they do not need a paper collection, a PDF download or a fixed bibliography size.

Choose a discovery → screening → core reading → targeted gap workflow. A broad
topic is not permission to open every result or to silently discard hard parts.
Use user-provided aims and constraints; when they are missing, state reasonable
scope assumptions and continue. Ask only if an ambiguity materially changes the
research question, experiment, eligibility criteria or required evidence.

Analyze uploaded papers directly. Before academic browser automation, follow
academic-research's access-scope workflow: agree on sites, purpose and reading/
download scope, including save destination; reuse explicit authorization already
given. The user need not choose the sites. Continue within the grant, confirm
additions/expansions, and skip refused operations without abandoning the whole
research. Ordinary public metadata discovery uses search/read tools and does not
require opening or authorizing a browser for every result.

1. Define questions, key concepts/synonyms, date/language/document scope and
   necessary evidence (e.g. material, loading, boundary conditions, frequency,
   failure criterion). Retain the plan and useful findings; use a structured
   checkpoint only when tracking complexity or resumption calls for it.
2. Start with 2–3 complementary queries in one literature_search call. It uses
   Crossref without a new account. Coverage and abstracts are incomplete: also
   use field-specific public indexes/web_search when relevant. Treat title/DOI/
   dates as discovery; do not infer experiments or conclusions from a title.
3. Deduplicate DOI/URL aliases, screen relevance and abstract availability in a
   batch. Select core papers by relevance to the questions and needed evidence,
   rather than promising a fixed candidate or full-text count.
   Preserve adverse findings and methodological disagreements. For an actual
   systematic review, use explicit multi-database eligibility, reproducible
   queries, screening counts and broader coverage; disclose access limitations.
4. Read core originals or lawful open repository/author versions. Use read_paper
   for direct public HTTPS PDFs: bounded pages, relevant sections and cursors.
   Downloaded HTML, CAPTCHA, certificate errors and paywalls are not full text.
   Use browser handoff only for an essential source; don't repeatedly navigate
   a blocked URL. Do not bypass security, licenses or access controls.
   Read HTML landing pages/sections with read_webpage; reuse its cached source
   with selector/next_offset instead of Python downloads. Do not depend on bs4.
   A 404/410 needs a verified replacement URL, 403/verification needs an accessible
   source or essential-source handoff, and 429 needs another source/existing
   evidence. Do not repeat the same blocked request through different tools.
5. Record source, evidence level, exact support, uncertainty and relevant pages
   in batches. Method selection, numerical parameters and research plans need
   the relevant methods/results, not just abstracts. Export saved findings with
   export-sources; keep unverified metadata candidates outside verified evidence.
6. Inspect question coverage and use targeted searches for material gaps.
   Stop after evidence suffices; if important gaps remain, describe them and
   their effect on recommendations. User-requested broader coverage can extend
   the plan. Numeric coverage alone never proves quality or independence.
7. Synthesize once into the requested report, checking claim support, conflicts
   and citation accuracy. Use structured source/report validation when an audit
   or reproducible review requires it, patch only deficient sections, then
   deliver. Intermediate checkpoints and drafts aren't extra deliverables.

Public references: [Crossref metadata and full-text links](https://www.crossref.org/documentation/retrieve-metadata/text-and-data-mining/),
[Semantic Scholar API](https://api.semanticscholar.org/api-docs),
[OpenAlex content availability](https://help.openalex.org/data/works/attributes/),
[Unpaywall OA links](https://unpaywall.org/data-format).
These have different coverage, access rules and quotas; do not promise that every
paper or full text is freely available. No additional service key is assumed.
