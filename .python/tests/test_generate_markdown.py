"""Regression checks for language sources, historical release data and generated artifacts."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("markdown", ROOT / ".python/generate_markdown.py")
markdown = importlib.util.module_from_spec(spec)
spec.loader.exec_module(markdown)


class DocumentationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="autojs6-localized-docs-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for directory in (".readme", ".changelog"):
            shutil.copytree(ROOT / directory, self.root / directory)
        for relative in (".python/docs_config.json", "package.json"):
            source = ROOT / relative
            if source.exists():
                target = self.root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        with contextlib.redirect_stdout(io.StringIO()):
            markdown.process_artifacts(self.root, markdown.build_artifacts(self.root), False)

    def change_json(self, relative, action):
        path = self.root / relative
        data = json.loads(path.read_text(encoding="utf-8"))
        action(data)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def snapshot(self):
        return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in self.root.rglob("*") if p.is_file()}

    def check(self):
        markdown.process_artifacts(self.root, markdown.build_artifacts(self.root), True)

    def test_check_is_read_only_and_root_readme_is_chinese(self):
        before = self.snapshot()
        self.check()
        self.assertEqual(before, self.snapshot())
        self.assertEqual((self.root / "README.md").read_bytes(),
                         (self.root / ".readme/README-zh-Hans.md").read_bytes())
        self.assertFalse((self.root / "CHANGELOG.md").exists())
        self.assertFalse((self.root / "README-en.md").exists())

    def test_missing_and_stale_outputs_are_not_repaired(self):
        path = self.root / ".readme/README-fr.md"
        for present in (True, False):
            with self.subTest(present=present):
                if present:
                    path.write_text("Manual edit\n", encoding="utf-8")
                else:
                    path.unlink()
                before = self.snapshot()
                with self.assertRaisesRegex(markdown.MarkdownGenerationError, "stale:|missing:"):
                    self.check()
                self.assertEqual(before, self.snapshot())

    def test_root_aliases_fail_before_any_write(self):
        for name in ("CHANGELOG.md", "README-en.md"):
            path = self.root / name
            path.write_text("Obsolete alias\n", encoding="utf-8")
            before = self.snapshot()
            for check in (True, False):
                with self.assertRaisesRegex(markdown.MarkdownGenerationError, "Orphan"):
                    markdown.process_artifacts(self.root, markdown.build_artifacts(self.root), check)
                self.assertEqual(before, self.snapshot())
            path.unlink()

    def test_missing_or_extra_language_is_rejected(self):
        path = self.root / ".readme/lang_de.json"
        path.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "extra="):
            self.check()
        path.unlink()
        (self.root / ".changelog/lang_ar.json").unlink()
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "missing="):
            self.check()

    def test_missing_translation_field_is_rejected(self):
        self.change_json(".readme/lang_ja.json", lambda data: data.pop("p_documentation"))
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "keys, types, or list lengths"):
            self.check()

    def test_missing_historical_entry_is_rejected(self):
        self.change_json(".changelog/lang_fr.json", lambda data: next(iter(data["$data"].values()))["entries"].pop())
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "keys, types, or list lengths"):
            self.check()

    def test_changed_historical_date_is_rejected(self):
        self.change_json(".changelog/lang_en.json", lambda data: next(iter(data["$data"].values())).update(released_date="2099/12/31"))
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "date differs"):
            self.check()

    def test_changed_category_is_rejected(self):
        def change(data):
            for item in next(iter(data["$data"].values()))["entries"]:
                if "category" in item:
                    item["category"] = "fix" if item["category"] != "fix" else "feature"
                    return
        self.change_json(".changelog/lang_en.json", change)
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "category differs"):
            self.check()

    def test_duplicate_json_keys_are_rejected(self):
        path = self.root / ".readme/common.json"
        path.write_text('{"project_name":"one","project_name":"two"}', encoding="utf-8")
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "Duplicate JSON key"):
            self.check()

    def test_escaped_punctuation_is_checked_after_decoding(self):
        self.change_json(".readme/lang_es.json", lambda data: data.update(p_documentation="Example\u2019s"))
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "Non-ASCII punctuation"):
            self.check()

    def test_unresolved_and_cyclic_references_are_rejected(self):
        self.change_json(".readme/common.json", lambda data: data.update(project_name="{{ unknown_key }}"))
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "Missing template value"):
            self.check()
        self.change_json(".readme/common.json", lambda data: data.update(project_name="{{ project_name }}"))
        with self.assertRaisesRegex(markdown.MarkdownGenerationError, "Cyclic"):
            self.check()

    def test_package_version_and_compatibility_aliases(self):
        config = json.loads((self.root / ".python/docs_config.json").read_text(encoding="utf-8"))
        for alias, code in config["changelog_aliases"].items():
            self.assertEqual((self.root / alias).read_bytes(),
                             (self.root / f".changelog/CHANGELOG-{code}.md").read_bytes())
        if config["versioned"]:
            self.change_json("package.json", lambda data: data.update(version="9999.0.0"))
            with self.assertRaisesRegex(markdown.MarkdownGenerationError, "package.json"):
                self.check()

    def test_cli_works_outside_repository_and_does_not_write(self):
        script = self.root / ".python/generate_markdown.py"
        shutil.copy2(ROOT / ".python/generate_markdown.py", script)
        before = self.snapshot()
        result = subprocess.run([sys.executable, "-B", str(script), "--check"],
                                cwd=self.root.parent, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("MARKDOWN_OK languages=10", result.stdout)
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    unittest.main()
