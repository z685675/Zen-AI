---
name: academic-research
description: Organize literature reviews and academic research by question, scope, evidence cards, source quality, and research gaps. Use for 文献综述、研究现状、研究进展、相关工作、系统综述、论文检索、学术研究, or literature review tasks, even when the user does not name a Skill.
---

# Academic Research

Turn a research topic into a traceable literature and evidence workflow. This Skill complements `$research-report`; use the research report source matrix and quality gate for source-heavy or Deep Research tasks.

## Workflow

1. Define the research question, scope, geography, time range, document types, inclusion criteria, and intended use. If the user did not specify them, make conservative assumptions and state them.
2. Expand the query in the user's language and English with synonyms, abbreviations, competing terminology, and method names.
3. Prefer direct paper, publisher, repository, DOI, or official dataset pages. Use search results only for discovery and never as the final citation.
4. Create one evidence card per retained paper:
   - stable ID, title, authors, year, venue, DOI or direct URL
   - research question, method, data or sample, main finding
   - limitation, relevance to the current question, confidence, and conflicts
5. Deduplicate by DOI first, then normalized title and author-year. Do not merge papers merely because their titles look similar.
6. Synthesize by research question, not by a paper-by-paper list. Identify agreement, disagreement, methodological patterns, blind spots, and open gaps.

## Integrity Rules

- Never invent a paper, author, DOI, quotation, dataset, result, or publication date.
- Mark a source as unverified when the page cannot be opened or the metadata conflicts.
- Separate sourced facts, interpretation, hypotheses, and recommendations.
- Preserve direct clickable URLs beside claims that depend on current or external evidence.
- If the evidence base is narrow, say so and explain what could change the conclusion.

## Default Output

1. Short answer and scope
2. Search and inclusion method
3. Literature landscape or evidence matrix
4. Findings by research question
5. Agreements, conflicts, and limitations
6. Research gaps and candidate directions
7. Sources with direct URLs

For DOCX, PDF, or spreadsheet delivery, use the matching format Skill after the evidence is verified. Do not treat an unverified draft as a finished paper review.
