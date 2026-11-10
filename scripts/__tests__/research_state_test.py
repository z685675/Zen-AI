"""Behavior regressions for research continuation, source identity and bounded reads."""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "resources/skills/research-report/scripts/research_state.py"
SPEC = importlib.util.spec_from_file_location("research_state", SCRIPT)
STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STATE)


class ResearchStateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "研究进度/state.sqlite3"
        self.plan = {"questions": [{"id": "Q1", "question": "载荷如何控制？", "min_sources": 2},
                                   {"id": "Q2", "question": "哪些边界仍不确定？", "min_sources": 1}], "max_pages": 3}
        self.db = STATE.connect(self.path)
        self.addCleanup(self.db.close)
        with self.db:
            STATE.initialize(self.db, "task-7319", self.plan)

    def reserve(self, **item):
        with self.db:
            return STATE.reserve(self.db, [item])[0]

    def test_source_export_reuses_findings_and_separates_metadata_candidates(self):
        candidate = self.reserve(method="metadata", url="https://candidate.example/a", doi="10.1234/a", title="Candidate")
        self.record(candidate, level="metadata")
        read = self.reserve(method="browser", url="https://paper.example/b", doi="10.1234/b", title="Core paper")
        self.record(read, level="full_text", findings=[{"question_id": "Q1", "claim": "Verified method"}])
        result = STATE.export_sources(self.db)
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(result["sources"][0]["supports"], ["Verified method"])
        self.assertEqual(result["sources"][0]["evidence_level"], "full_text")
        self.assertEqual(result["sources"][0]["url"], "https://paper.example/b")
        self.assertEqual(len(result["candidates"]), 1)

    def record(self, attempt, outcome="success", **extra):
        with self.db:
            return STATE.record(self.db, [{"attempt_id": attempt["attempt_id"], "outcome": outcome, **extra}])

    def test_reopen_in_another_process_preserves_findings_failures_and_pending_reads(self):
        read = self.reserve(method="browser", url="https://journal.example/paper")
        self.record(read, level="abstract", findings=[{"question_id": "Q1", "claim": "摘要支持频率跟踪控制"}])
        failed = self.reserve(method="browser", url="https://journal.example/blocked")
        self.record(failed, "blocked", detail="CAPTCHA; public alternative required")
        self.reserve(method="search", query="composite resonance fatigue")
        result = subprocess.run([sys.executable, "-X", "utf8", "-B", str(SCRIPT), "--db", str(self.path), "status"],
                                capture_output=True, text=True, encoding="utf-8", check=True)
        snapshot = json.loads(result.stdout)
        self.assertEqual(snapshot["questions"][0]["findings"][0]["claim"], "摘要支持频率跟踪控制")
        self.assertEqual(snapshot["failures"][0]["outcome"], "blocked")
        self.assertEqual(len(snapshot["pending"]), 1)
        self.assertEqual(snapshot["next_step"], "settle_pending_reads")

    def test_tracking_url_and_query_aliases_are_not_executed_twice(self):
        first = self.reserve(method="browser", url="https://EXAMPLE.org/paper/?utm_source=mail#abstract")
        again = self.reserve(method="browser", url="https://example.org/paper")
        self.assertEqual(again["decision"], "skip")
        self.assertEqual(again["attempt_id"], first["attempt_id"])
        query = self.reserve(method="search", query="  Composite   FATIGUE ")
        self.record(query, detail="Discovery only: example.org/paper")
        self.assertEqual(self.reserve(method="search", query="composite fatigue")["decision"], "reuse")

    def test_full_text_doi_alias_is_reused_and_does_not_inflate_coverage(self):
        first = self.reserve(method="browser", url="https://journal.example/a", doi="10.1234/ABC")
        self.record(first, level="full_text", findings=[{"question_id": "Q1", "claim": "Method verified"}])
        again = self.reserve(method="repository", url="https://university.example/paper.pdf", doi="https://doi.org/10.1234/abc")
        self.assertEqual(again["decision"], "reuse")
        self.assertEqual(again["source_id"], first["source_id"])
        snapshot = STATE.status(self.db)
        self.assertEqual(snapshot["questions"][0]["source_count"], 1)
        self.assertFalse(snapshot["questions"][0]["coverage_met"])
        self.assertEqual(snapshot["source_registry"][0]["doi"], "10.1234/abc")
        self.assertEqual(len(snapshot["source_registry"][0]["urls"]), 2)

    def test_learning_a_doi_merges_existing_url_records_without_losing_findings(self):
        first = self.reserve(method="metadata", url="https://journal.example/a")
        self.record(first, level="metadata")
        second = self.reserve(method="repository", url="https://university.example/a", doi="10.1234/abc")
        self.record(second, level="abstract", findings=[{"question_id": "Q1", "claim": "Abstract verified"}])
        merged = self.reserve(method="metadata", url="https://journal.example/a", doi="10.1234/abc")
        self.assertEqual(merged["decision"], "reuse")
        self.assertEqual(merged["source_id"], second["source_id"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0], 1)
        self.assertEqual(len(STATE.status(self.db)["questions"][0]["findings"]), 1)

    def test_terminal_failures_cannot_be_retried_but_a_public_alternative_can(self):
        for outcome in ["blocked", "certificate", "not_found"]:
            original = self.reserve(method="fetch", url=f"https://example.org/{outcome}")
            self.record(original, outcome)
            self.assertEqual(self.reserve(method="fetch", url=f"https://example.org/{outcome}", retry_transient=True)["decision"], "skip")
        fallback = self.reserve(method="repository", url="https://university.example/open.pdf")
        self.assertEqual(fallback["decision"], "execute")

    def test_conflicting_identifiers_do_not_merge_distinct_papers(self):
        first = self.reserve(method="metadata", url="https://example.org/first", doi="10.1234/first")
        second = self.reserve(method="metadata", url="https://example.org/second", doi="10.1234/second")
        with self.db, self.assertRaisesRegex(ValueError, "Conflicting DOI"):
            STATE.source(self.db, {"doi": "10.1234/second"}, "https://example.org/first")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0], 2)
        self.assertNotEqual(first["source_id"], second["source_id"])
        with self.assertRaisesRegex(ValueError, "resolver URL"):
            self.reserve(method="metadata", url="https://doi.org/10.1234/first", doi="10.1234/second")

    def test_transient_retry_requires_explicit_flag_and_only_one_is_allowed(self):
        original = self.reserve(method="fetch", url="https://example.org/slow")
        self.record(original, "timeout")
        self.assertEqual(self.reserve(method="fetch", url="https://example.org/slow")["decision"], "skip")
        second = self.reserve(method="fetch", url="https://example.org/slow", retry_transient=True)
        self.assertEqual(second["decision"], "execute")
        self.record(second, "timeout")
        self.assertEqual(self.reserve(method="fetch", url="https://example.org/slow", retry_transient=True)["decision"], "skip")

    def test_pending_claim_survives_interruption_and_is_never_silently_replayed(self):
        first = self.reserve(method="browser", url="https://example.org/pending")
        self.assertEqual(self.reserve(method="browser", url="https://example.org/pending", retry_transient=True)["decision"], "skip")
        self.record(first, "interrupted")
        self.assertEqual(self.reserve(method="browser", url="https://example.org/pending", retry_transient=True)["decision"], "execute")

    def test_source_has_two_content_routes_and_metadata_does_not_consume_them(self):
        for method, domain in [("metadata", "doi"), ("browser", "publisher"), ("repository", "author")]:
            item = self.reserve(method=method, url=f"https://{domain}.example/paper", doi="10.1234/example")
            self.record(item, "blocked")
        denied = self.reserve(method="fetch", url="https://mirror.example/paper", doi="10.1234/example")
        self.assertEqual(denied["reason"], "source_route_budget")

    def test_metadata_and_search_snippets_cannot_establish_question_coverage(self):
        for item in [{"method": "search", "query": "discover paper"}, {"method": "metadata", "url": "https://doi.org/10.1234/test"}]:
            attempt = self.reserve(**item)
            with self.assertRaisesRegex(ValueError, "cannot count"):
                self.record(attempt, level="metadata", findings=[{"question_id": "Q1", "claim": "Unsupported"}])
            self.record(attempt, level="metadata")
        self.assertEqual(STATE.status(self.db)["questions"][0]["source_count"], 0)

    def test_abstracts_cannot_satisfy_a_question_requiring_full_methods(self):
        with self.db:
            self.db.execute("UPDATE questions SET required_level='full_text',minimum=1 WHERE id='Q1'")
        attempt = self.reserve(method="fetch", url="https://example.org/abstract")
        self.record(attempt, level="abstract", findings=[{"question_id": "Q1", "claim": "Abstract-level indication"}])
        self.assertFalse(STATE.status(self.db)["questions"][0]["coverage_met"])
        full = self.reserve(method="fetch", url="https://example.org/full")
        self.record(full, level="full_text", findings=[{"question_id": "Q1", "claim": "Methods inspected"}])
        self.assertTrue(STATE.status(self.db)["questions"][0]["coverage_met"])

    def test_low_confidence_findings_remain_visible_without_satisfying_coverage(self):
        attempt = self.reserve(method="fetch", url="https://example.org/uncertain")
        self.record(attempt, level="abstract", findings=[{"question_id": "Q2", "claim": "Weakly supported", "confidence": "low"}])
        question = STATE.status(self.db)["questions"][1]
        self.assertFalse(question["coverage_met"])
        self.assertEqual(len(question["findings"]), 1)

    def test_compact_pass_snapshots_do_not_repeat_all_evidence_but_keep_it_on_disk(self):
        attempt = self.reserve(method="fetch", url="https://example.org/evidence")
        self.record(attempt, level="full_text", findings=[{"question_id": "Q1", "claim": "Previously verified finding"}])
        snapshot = STATE.status(self.db, detailed=False)
        self.assertNotIn("findings", snapshot["questions"][0])
        self.assertNotIn("source_registry", snapshot)
        self.assertEqual(snapshot["source_count"], 1)
        self.assertEqual(snapshot["questions"][0]["source_count"], 1)
        self.assertEqual(STATE.status(self.db)["questions"][0]["findings"][0]["claim"], "Previously verified finding")

    def test_reused_content_can_support_a_second_question_without_another_fetch(self):
        attempt = self.reserve(method="fetch", url="https://example.org/content")
        self.record(attempt, level="abstract", findings=[{"question_id": "Q1", "claim": "Frequency range reported"}])
        with self.db:
            STATE.annotate(self.db, [{"attempt_id": attempt["attempt_id"], "question_id": "Q2", "claim": "Narrow loading range"}])
        self.assertTrue(STATE.status(self.db)["questions"][1]["coverage_met"])
        # Replaying the first result is idempotent, including default confidence.
        self.record(attempt, level="abstract", findings=[{"question_id": "Q1", "claim": "Frequency range reported"}])
        with self.assertRaisesRegex(ValueError, "different result"):
            self.record(attempt, "blocked")

    def test_page_budget_stops_more_browser_work_without_hiding_gaps(self):
        for i in range(3):
            attempt = self.reserve(method="browser", url=f"https://example.org/paper/{i}")
            self.record(attempt, "timeout")
        denied = self.reserve(method="browser", url="https://example.org/paper/4")
        self.assertEqual(denied["reason"], "page_budget")
        self.assertEqual(STATE.status(self.db)["next_step"], "synthesize_with_limitations")
        self.assertFalse(STATE.status(self.db)["questions"][0]["coverage_met"])

    def test_full_text_reuse_does_not_require_spare_browser_budget(self):
        with self.db:
            self.db.execute("UPDATE meta SET value='1' WHERE key='max_pages'")
        first = self.reserve(method="browser", url="https://journal.example/full", doi="10.1234/full")
        self.record(first, level="full_text", findings=[{"question_id": "Q1", "claim": "Methods verified"}])
        alias = self.reserve(method="browser", url="https://university.example/full", doi="10.1234/full")
        self.assertEqual(alias["decision"], "reuse")
        self.assertEqual(alias["attempt_id"], first["attempt_id"])
        self.assertEqual(STATE.status(self.db)["browser_pages"], 1)

    def test_reusing_a_read_still_rejects_conflicting_new_doi_metadata(self):
        original = self.reserve(method="fetch", url="https://journal.example/paper", doi="10.1234/first")
        self.record(original, level="abstract")
        with self.assertRaisesRegex(ValueError, "Conflicting DOI"):
            self.reserve(method="fetch", url="https://journal.example/paper", doi="10.1234/other")

    def test_followup_passes_are_bounded_in_persisted_state(self):
        for allowed in [True, True, False]:
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--db", str(self.path), "gap-pass"],
                                    capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["allowed"], allowed)
        self.assertEqual(STATE.status(self.db)["next_step"], "synthesize_with_limitations")

    def test_followup_reservation_and_budget_are_atomic_without_extra_status_call(self):
        for index in range(3):
            batch = [{"method": "search", "query": f"gap {index}"}]
            result = subprocess.run([sys.executable, "-X", "utf8", "-B", str(SCRIPT), "--db", str(self.path),
                                     "reserve", "--gap-pass", "--json", json.dumps(batch)],
                                    capture_output=True, text=True, encoding="utf-8", check=True)
            output = json.loads(result.stdout)
            self.assertEqual(output["allowed"], index < 2)
            self.assertEqual(output["state"]["gap_passes"], min(index + 1, 2))
            self.assertEqual(len(output["reservations"]), 1 if index < 2 else 0)
        self.assertEqual(len(STATE.status(self.db)["pending"]), 2)

    def test_init_can_reserve_the_first_pass_and_return_saved_progress_in_one_call(self):
        other_path = Path(self.directory.name) / "new-task.sqlite3"
        plan = {**self.plan, "reads": [{"method": "search", "query": "first research pass"}]}
        result = subprocess.run([sys.executable, "-X", "utf8", "-B", str(SCRIPT), "--db", str(other_path),
                                 "init", "--task-id", "new-task", "--json", json.dumps(plan)],
                                capture_output=True, text=True, encoding="utf-8", check=True)
        output = json.loads(result.stdout)
        self.assertEqual(output["reservations"][0]["decision"], "execute")
        self.assertEqual(output["state"]["task_id"], "new-task")

    def test_two_concurrent_workers_reserve_a_url_only_once(self):
        def worker(_):
            with closing(STATE.connect(self.path)) as db, db:
                db.execute("BEGIN IMMEDIATE")
                return STATE.reserve(db, [{"method": "fetch", "url": "https://example.org/shared"}])[0]["decision"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(worker, range(2))), ["execute", "skip"])

    def test_bad_batch_rolls_back_prior_reservations_in_cli(self):
        batch = [{"method": "browser", "url": "https://example.org/new"}, {"method": "browser", "url": "file:///secret"}]
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--db", str(self.path), "reserve", "--json", json.dumps(batch)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(STATE.status(self.db)["pending"], [])

    def test_plan_and_task_mismatch_do_not_erase_saved_progress(self):
        with self.db:
            self.assertTrue(STATE.initialize(self.db, "task-7319", self.plan)["reused"])
        with self.assertRaisesRegex(ValueError, "another task"):
            STATE.initialize(self.db, "other-task", self.plan)
        with self.assertRaisesRegex(ValueError, "plan differs"):
            STATE.initialize(self.db, "task-7319", {**self.plan, "max_pages": 50})
        self.assertEqual(STATE.status(self.db)["task_id"], "task-7319")


if __name__ == "__main__":
    unittest.main()
