from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


SOURCE_MATRIX_PATH = (
    Path(__file__).resolve().parents[2] / "resources" / "skills" / "research-report" / "scripts" / "source_matrix.py"
)
SOURCE_MATRIX_SPEC = importlib.util.spec_from_file_location("research_source_matrix", SOURCE_MATRIX_PATH)
if SOURCE_MATRIX_SPEC is None or SOURCE_MATRIX_SPEC.loader is None:
    raise RuntimeError(f"Unable to load source matrix module: {SOURCE_MATRIX_PATH}")
SOURCE_MATRIX_MODULE = importlib.util.module_from_spec(SOURCE_MATRIX_SPEC)
sys.modules[SOURCE_MATRIX_SPEC.name] = SOURCE_MATRIX_MODULE
SOURCE_MATRIX_SPEC.loader.exec_module(SOURCE_MATRIX_MODULE)
build_matrix = SOURCE_MATRIX_MODULE.build_matrix


class EvidenceLevelTest(unittest.TestCase):
    def test_metadata_candidates_do_not_inflate_content_evidence_counts(self):
        result = build_matrix(json.dumps([{"title": "Candidate", "url": "https://papers.example/a?utm_source=test", "evidence_level": "metadata"},
                                         {"title": "Core", "url": "https://repository.example/b", "evidence_level": "full_text", "supports": ["Read result"]}]))
        self.assertEqual(result["source_count"], 2)
        self.assertEqual(result["unique_direct_source_count"], 1)
        self.assertEqual(result["metadata_candidate_count"], 1)
        self.assertEqual(result["sources"][1]["evidence_level"], "full_text")


def source(index: int, url: str | None = None) -> dict[str, object]:
    return {
        "title": f"Source {index}",
        "publisher": f"Publisher {index}",
        "url": url or f"https://source{index}.example.com/report",
        "date": "2026-07-31",
        "supports": [f"Claim {index}"],
        "confidence": "high",
    }


class SourceMatrixTests(unittest.TestCase):
    def test_strict_matrix_and_report_pass(self) -> None:
        sources = [source(index) for index in range(1, 9)]
        report = """# Findings
Supported finding [S1](https://source1.example.com/report).

## Sources
- [Source 1](https://source1.example.com/report)
- [Source 2](https://source2.example.com/report)
- [Source 3](https://source3.example.com/report)
- [Source 4](https://source4.example.com/report)

## Limitations
Some sources may change.
"""
        result = build_matrix(
            json.dumps(sources),
            strict=True,
            report=report,
        )

        self.assertTrue(result["quality_gate"]["passed"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["unique_direct_source_count"], 8)

    def test_strict_mode_rejects_duplicates_and_search_pages(self) -> None:
        sources = [source(index) for index in range(1, 9)]
        sources[1]["url"] = "https://source1.example.com/report?utm_source=test"
        sources[2]["url"] = "https://www.google.com/search?q=research"

        result = build_matrix(json.dumps(sources), strict=True)

        self.assertFalse(result["quality_gate"]["passed"])
        self.assertTrue(any("Duplicate source URLs" in error for error in result["errors"]))
        self.assertTrue(any("Search-results pages" in error for error in result["errors"]))

    def test_strict_report_requires_links_sources_and_limitations(self) -> None:
        sources = [source(index) for index in range(1, 9)]
        result = build_matrix(
            json.dumps(sources),
            strict=True,
            report="# Findings\nA conclusion without traceable links.",
        )

        self.assertFalse(result["quality_gate"]["passed"])
        self.assertTrue(any("Sources or References" in error for error in result["errors"]))
        self.assertTrue(any("Limitations" in error for error in result["errors"]))
        self.assertTrue(any("no clickable source URLs" in error for error in result["errors"]))

    def test_same_doi_at_different_urls_does_not_inflate_independent_source_count(self) -> None:
        sources = [source(index) for index in range(1, 9)]
        sources[0]["doi"] = "https://doi.org/10.1234/ABC"
        sources[1]["doi"] = "doi:10.1234/abc"
        result = build_matrix(json.dumps(sources), strict=True)
        self.assertFalse(result["quality_gate"]["passed"])
        self.assertEqual(result["unique_direct_source_count"], 7)
        self.assertEqual(result["unique_url_count"], 8)
        self.assertTrue(any("Duplicate DOI" in error for error in result["errors"]))

    def test_invalid_doi_is_not_accepted_as_a_verified_identifier(self) -> None:
        sources = [source(index) for index in range(1, 9)]
        sources[0]["doi"] = "guessed-paper-id"
        result = build_matrix(json.dumps(sources), strict=True)
        self.assertTrue(any("Invalid DOI" in error for error in result["errors"]))

    def test_non_strict_mode_keeps_small_ad_hoc_usage_compatible(self) -> None:
        result = build_matrix(
            json.dumps([source(1)]),
            strict=False,
        )

        self.assertTrue(result["quality_gate"]["passed"])
        self.assertEqual(result["errors"], [])
        self.assertTrue(any("strict minimum" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
