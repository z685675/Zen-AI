# Numeric and methods/results consistency

Use `assets/consistency-manifest.json` as a schema example. Replace every placeholder with values extracted from the actual manuscript; never manufacture a sample, method or result to satisfy the checker. Keep a section/location for each repeated fact.

Run `scripts/scientific_writing/check_consistency.py` through `mcp__assistant__python_execute` with `arguments: ["consistency-manifest.json"]`. Python 3.11+ and the standard library are sufficient. Read its JSON output and exit code (0 success, 1 findings/error).

The registry contains `schema_version`, `numeric_facts`, `methods` and `results`. It checks repeated concepts, units, denominators, sample sizes, method/result mappings and analysis intent. It does not read a DOCX/PDF automatically. Compare the registry back to the source manuscript, and report how many facts/methods/results were actually covered. An empty registry is not substantive verification, and evidence IDs do not prove the source exists or supports a claim.

Resolve discrepancies against author data/sources. Preserve uncertainty and distinguish exploratory from prespecified results. Do not silently choose one conflicting value or invent statistics. Use this check for empirical drafts or explicit consistency requests, rather than every short writing task.

Selected K-Dense helpers are pinned in `upstream.json` under the adjacent MIT license. No external image, search or export service is added.
