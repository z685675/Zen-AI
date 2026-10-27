# Citation checks

Use the managed Python tool `mcp__assistant__python_execute`, with `script_path` under this skill and `arguments` as below. The managed runtime needs `requests`; do not install into system Python.

1. Offline bibliography check: `scripts/citation_management/validate_citations.py` with `references.bib --manuscript manuscript.md --report citation-report.json`.
2. Only when DOI existence needs checking, add `--check-dois`. Queries are serial with bounded network timeouts; reuse previous verified results rather than querying unchanged identifiers again.
3. For a conflicting/new record, run `scripts/citation_management/extract_metadata.py` with `--doi <DOI> --format json --output metadata.json`. Compare returned title, authors and year against the actual entry, then read the source to assess claim support. A successful lookup alone does neither comparison.

Read the JSON report as well as the exit code: `duplicates` is separate from `errors`; `doi_unverified` is a warning, never a verified citation. Failed/partial extraction has exit code 2. Account for input entries versus parsed entries: the BibTeX/Markdown parser is limited and can skip malformed input. Keep unparsed/conflicting/unreachable sources visible to the user. Do not automatically rewrite citations using uncertain metadata.

These selected helpers come from K-Dense scientific-agent-skills at the revision recorded in `upstream.json`, under the adjacent MIT license. They do not require optional paid search, export, or image services.
