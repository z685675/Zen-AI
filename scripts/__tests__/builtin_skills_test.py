"""Behavior checks for selected community helpers and the OpenCode maintenance adapter."""
import importlib.util
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / "resources" / "skills"
sys.path.insert(0, str(SKILLS / "skill-creator"))
from scripts import opencode_runner, run_eval, run_loop


def load_helper(name, directory, filename):
    sys.modules.pop("_common", None)  # The two upstream helpers deliberately have different modules.
    sys.path.insert(0, str(directory))
    try:
        spec = importlib.util.spec_from_file_location(name, directory / filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


class OpenCodeEvaluationTests(unittest.TestCase):
    def test_completed_skill_must_match_exact_name(self):
        events = opencode_runner.parse_events('\n'.join(json.dumps(item) for item in [
            {"type": "tool_use", "part": {"tool": "skill", "state": {
                "status": "completed", "input": {"name": "writing"}}}},
            {"type": "step_finish", "part": {"reason": "stop"}},
        ]))
        self.assertTrue(opencode_runner.skill_triggered(events, "writing"))
        self.assertFalse(opencode_runner.skill_triggered(events, "write"))

    def test_error_partial_and_failed_tool_are_not_valid_negative_results(self):
        for events in [[], [{"type": "error"}], [{"type": "step_finish", "part": {"reason": "tool-calls"}}],
                       [{"type": "tool_use", "part": {"state": {"status": "error"}}},
                        {"type": "step_finish", "part": {"reason": "stop"}}]]:
            with self.assertRaises(opencode_runner.OpenCodeExecutionError):
                opencode_runner.parse_events('\n'.join(json.dumps(event) for event in events))

    def test_transport_failure_never_passes_a_negative_case(self):
        with patch.object(run_eval, "ProcessPoolExecutor", ThreadPoolExecutor), \
             patch.object(run_eval, "run_single_query", side_effect=TimeoutError("fixture timeout")):
            report = run_eval.run_eval([{"query": "irrelevant", "should_trigger": False}],
                                      "writing", "description", 1, 1, ROOT)
        self.assertEqual(report["summary"], {"total": 1, "passed": 0, "failed": 1, "errors": 1})
        self.assertIsNone(report["results"][0]["trigger_rate"])

    def test_optimization_refuses_runtime_errors(self):
        with patch.object(run_loop, "run_eval", return_value={"summary": {"errors": 1}}), \
             patch.object(run_loop, "improve_description") as improve:
            with self.assertRaisesRegex(RuntimeError, "runtime failed"):
                run_loop.run_loop([{"query": "test", "should_trigger": True}], SKILLS / "content-writer-cn",
                                  None, 1, 1, 2, 1, .5, 0, "fixture/model", False)
            improve.assert_not_called()

    def test_config_is_required_and_temporary_skill_names_are_safe(self):
        with patch.dict("os.environ", {"ZEN_OPENCODE_EXECUTABLE": "fixture", "OPENCODE_CONFIG_CONTENT": "{}"}):
            with self.assertRaises(opencode_runner.OpenCodeExecutionError):
                opencode_runner.run_opencode("test")
        with patch.dict("os.environ", {"ZEN_OPENCODE_EXECUTABLE": "fixture",
                        "OPENCODE_CONFIG_CONTENT": '{"provider":{"fixture":{}},"model":"fixture/model"}'}):
            with self.assertRaises(ValueError):
                opencode_runner.run_opencode("test", skill_name="../escape", description="test")


class AcademicHelperTests(unittest.TestCase):
    def test_metadata_extraction_returns_author_year_and_title_from_the_record(self):
        folder = SKILLS / "academic-research" / "scripts" / "citation_management"
        helper = load_helper("citation_metadata", folder, "extract_metadata.py")
        response = Mock(status_code=200)
        response.json.return_value = {"message": {"title": ["Verified fixture title"],
            "author": [{"given": "Yue", "family": "Lin"}], "published": {"date-parts": [[2026]]}}}
        extractor = helper.MetadataExtractor()
        with patch.object(extractor.session, "get", return_value=response) as request:
            record = extractor.extract_from_doi("10.1234/a?b")
        self.assertEqual(record["title"], "Verified fixture title")
        self.assertEqual(record["year"], "2026")
        self.assertIn("Lin", record["authors"])
        self.assertIn("a%3Fb", request.call_args.args[0])

    def test_offline_bibliography_handles_nested_braces_duplicates_and_missing_citations(self):
        folder = SKILLS / "academic-research" / "scripts" / "citation_management"
        helper = load_helper("citation_validator", folder, "validate_citations.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bib = root / "references.bib"
            bib.write_text('@article{a, title={A {DNA} study}, author={Lin, Yue}, year={2026}, '
                           'journal={Test Journal}, doi={10.1234/example}}\n'
                           '@article{b, title={A {DNA} study}, author={Lin, Yue}, year={2026}, '
                           'journal={Test Journal}, doi={10.1234/example}}', encoding="utf-8")
            manuscript = root / "draft.md"
            manuscript.write_text('Evidence [@missing].', encoding="utf-8")
            with patch.object(helper.requests.sessions.Session, "get", side_effect=AssertionError("Unexpected network")):
                validator = helper.CitationValidator()
                entries = validator.parse_bibtex_file(str(bib))
                self.assertIn("DNA", entries[0]["fields"]["title"])
                report = validator.validate_file(str(bib), manuscript_filepath=str(manuscript))
            self.assertEqual(report["total_entries"], 2)
            self.assertTrue(report["duplicates"])
            self.assertIn("missing", report["manuscript_results"]["missing_keys"])

    def test_numeric_consistency_detects_conflicts_but_distinguishes_old_and_final_budget(self):
        folder = SKILLS / "paper-writing" / "scripts" / "scientific_writing"
        def fact(number, concept, value, section):
            return {"fact_id": number, "concept": concept, "section": section, "value": value,
                    "unit": "CNY", "numerator": None, "denominator": None, "sample_size": None,
                    "analysis_set": "project", "evidence_ids": ["E001"]}
        helper = load_helper("consistency_checker", folder, "check_consistency.py")
        data = {"numeric_facts": [fact("N001", "old_budget", 600, "intro"),
                                  fact("N002", "final_budget", 700, "results"),
                                  fact("N003", "final_budget", 700, "conclusion")]}
        issues, count = helper.validate_numeric_facts(data)
        self.assertEqual(count, 3)
        self.assertFalse(issues)
        data["numeric_facts"][2]["value"] = 600
        issues, _ = helper.validate_numeric_facts(data)
        self.assertTrue(issues)

    def test_shipped_template_is_not_a_verified_result(self):
        script = SKILLS / "paper-writing" / "scripts" / "scientific_writing" / "check_consistency.py"
        result = subprocess.run([sys.executable, "-B", str(script), str(SKILLS / "paper-writing" / "assets" /
                                 "consistency-manifest.json")], capture_output=True, text=True, encoding="utf-8")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(json.loads(result.stdout)["issues"])


@unittest.skipUnless(os.environ.get("ZEN_SKILL_NATIVE_SMOKE") == "1", "optional native runtime smoke")
class NativeOpenCodeTests(unittest.TestCase):
    def test_native_positive_negative_and_description_generation(self):
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(body)
                has_result = any(message.get("role") == "tool" for message in body["messages"])
                positive = "positive-fixture" in json.dumps(body["messages"])
                if positive and not has_result:
                    delta = {"tool_calls": [{"index": 0, "id": "fixture-call", "type": "function",
                        "function": {"name": "skill", "arguments": '{"name":"content-writer-cn"}'}}]}
                else:
                    delta = {"content": "Controlled local response"}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for change, reason in [(delta, None), ({}, "tool_calls" if "tool_calls" in delta else "stop")]:
                    event = {"id": "fixture", "object": "chat.completion.chunk", "model": "fixture-model",
                             "created": 1, "choices": [{"index": 0, "delta": change, "finish_reason": reason}]}
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        config = {"model": "fixture/fixture-model", "provider": {"fixture": {
            "npm": "@ai-sdk/openai-compatible", "name": "Local fixture", "options": {
                "baseURL": f"http://127.0.0.1:{server.server_port}/v1", "apiKey": "local-placeholder"},
            "models": {"fixture-model": {"name": "Fixture", "limit": {"context": 32000, "output": 2000}}}}}}
        try:
            with patch.dict(os.environ, {"OPENCODE_CONFIG_CONTENT": json.dumps(config),
                            "ZEN_OPENCODE_DEPENDENCIES": str(ROOT / "resources" / "opencode-runtime")}):
                for positive in (True, False):
                    triggered = run_eval.run_single_query("positive-fixture" if positive else "negative-fixture",
                        "content-writer-cn", "Chinese content writing", 45, str(ROOT))
                    self.assertEqual(triggered, positive)
                self.assertEqual(opencode_runner.call_text("description-fixture", None, 45), "Controlled local response")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertEqual(len(calls), 4)


if __name__ == "__main__":
    unittest.main()
