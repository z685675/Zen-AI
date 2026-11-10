"""Regression checks for the document validation failures observed in long tasks."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def helper(skill):
    path = ROOT / "resources" / "skills" / skill / "scripts" / f"validate_{skill}.py"
    spec = importlib.util.spec_from_file_location(f"validation_{skill}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DOCX = helper("docx")
PDF = helper("pdf")


class DocumentValidationTests(unittest.TestCase):
    def test_signature_blanks_are_not_markdown_but_actual_emphasis_is(self):
        for module in (DOCX, PDF):
            pattern = module.MARKDOWN_LITERAL_PATTERNS["strong_emphasis"]
            for text in ["Signature: ________ Date: ________", "客户确认：________ 日期：________", "签字________日期________", "_____", "**mixed__"]:
                self.assertIsNone(pattern.search(text), text)
            for text in ["**最终预算**", "__final budget__", "**A**", "__中__", "***bold italic***", "___粗斜体___", "****nested bold****"]:
                self.assertIsNotNone(pattern.search(text), text)

    def test_pdf_signature_form_passes_and_raw_markdown_still_fails(self):
        import fitz
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "confirmation.pdf"
            with fitz.open() as document:
                page = document.new_page()
                page.insert_text((60, 70), "Signature: ________ Date: ________")
                document.save(path)
            self.assertTrue(PDF.validate_pdf(path, 1, [], False, no_markdown_literals=True)["pass"])
            with fitz.open() as document:
                page = document.new_page()
                page.insert_text((60, 70), "**Raw Markdown**")
                document.save(path)
            self.assertFalse(PDF.validate_pdf(path, 1, [], False, no_markdown_literals=True)["pass"])

    def test_page_count_uses_rendered_pdf_and_rejects_missing_stale_and_wrong_counts(self):
        import fitz
        with tempfile.TemporaryDirectory() as directory:
            docx = Path(directory) / "report.docx"
            docx.write_bytes(b"DOCX metadata must never be used as a page count")
            pdf = Path(directory) / "rendered.pdf"
            with fitz.open() as document:
                document.new_page()
                document.new_page()
                document.save(pdf)
            os.utime(pdf, ns=(docx.stat().st_mtime_ns + 1_000_000, docx.stat().st_mtime_ns + 1_000_000))
            self.assertTrue(DOCX.check_rendered_pages(docx, pdf, 2)["pass"])
            self.assertFalse(DOCX.check_rendered_pages(docx, pdf, 3)["pass"])
            self.assertFalse(DOCX.check_rendered_pages(docx, None, 2)["pass"])
            self.assertFalse(DOCX.check_rendered_pages(docx, Path(directory) / "missing.pdf", 2)["pass"])
            os.utime(pdf, ns=(1, 1))
            self.assertFalse(DOCX.check_rendered_pages(docx, pdf, 2)["pass"])

    def test_docx_cli_accepts_explicit_strict_flag_and_does_not_fake_page_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.docx"
            with zipfile.ZipFile(path, "w") as package:
                package.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
                package.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
                package.writestr("word/document.xml", f'<w:document xmlns:w="{DOCX.WORD_NS}"><w:body><w:p><w:r><w:t>Customer confirmation: ________ Date: ________</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')
            command = [sys.executable, DOCX.__file__, str(path), "--no-markdown-literals"]
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run(command + ["--expected-pages", "2"], capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertFalse(report["pagination"]["pass"])
            self.assertIn("--rendered-pdf", report["pagination"]["error"])


if __name__ == "__main__":
    unittest.main()
