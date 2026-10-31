"""Regression tests ensuring shared code never silently skips browser CI."""
from __future__ import annotations

from contextlib import redirect_stdout
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts.ci_browser_changes import browser_required, changed_paths, is_documentation_only, main


class BrowserChangesTests(unittest.TestCase):
    """Exercise skip rules and the safe fallbacks on incomplete inputs."""

    def test_docs_only_skips(self) -> None:
        """Readme, prose and evidence imagery do not require tower-defense browser tests."""
        self.assertFalse(browser_required([
            "README.md", "docs/game-runtime-verification.md",
            "docs/evidence/embodied-chat/chat-live.png", "LICENSE",
        ]))

    def test_shared_source_triggers(self) -> None:
        """Shared source changes must reach downstream consumers."""
        for path in [
            "src/lib/embodied-scene.ts", "server/game-service.mjs",
            "packages/material-science/src/index.ts",
            "scripts/game-world-test.ts", "tests/simulation/local-runtime.test.ts",
            "services/embodied/oi_embodied/server.py",
        ]:
            with self.subTest(path=path):
                self.assertTrue(browser_required(["README.md", path]))

    def test_workflow_and_dependency_changes_trigger(self) -> None:
        """Tests, fixtures, lockfiles, runtime config and workflows remain covered."""
        for path in [
            ".github/workflows/game-runtime.yml", "package-lock.json",
            "vite.config.ts", "public/examples/cleanroom/cleanroom-suite.json",
            "benchmarks/field-lab/fixtures/pipette-motion.json",
            "scripts/ci_browser_changes.py", "docs/evidence/embodied-chat/browser-checks.json",
        ]:
            with self.subTest(path=path):
                self.assertTrue(browser_required([path]))

    def test_unknown_paths_fail_open(self) -> None:
        """New source directories are included without editing a fragile allowlist."""
        self.assertTrue(browser_required(["new-library/feature.xyz"]))

    def test_executable_or_imported_prose_triggers(self) -> None:
        """MDX and Markdown application inputs are not assumed to be documentation."""
        for path in [
            "docs/example.mdx", "src/view.mdx", "src/instructions.md",
            "tests/fixtures/input.md", "public/examples/README.md",
            "unknown.md", ".github/ISSUE_TEMPLATE/custom.js", "docs/../src/input.md",
        ]:
            with self.subTest(path=path):
                self.assertTrue(browser_required([path]))

    def test_known_prose_and_issue_templates_skip(self) -> None:
        """Known contributor prose and GitHub issue templates do not execute in the app."""
        self.assertFalse(browser_required([
            "CONTRIBUTING.md", "CHANGELOG.md", "SECURITY.md",
            ".github/ISSUE_TEMPLATE/bug.md", ".github/ISSUE_TEMPLATE/bug.yml",
        ]))

    def test_empty_paths_fail_open(self) -> None:
        """An empty change set never silently suppresses browser coverage."""
        self.assertTrue(browser_required([]))

    def test_bad_base_fails_open(self) -> None:
        """Missing base history or a GitHub initial-push SHA cannot skip checks."""
        self.assertIsNone(changed_paths(""))
        self.assertIsNone(changed_paths("0" * 40))
        self.assertIsNone(changed_paths("not-a-sha"))

    def test_docs_json_is_not_skipped(self) -> None:
        """A potentially executable structured asset inside docs is not classified as prose."""
        self.assertFalse(is_documentation_only("docs/fixture.json"))
        self.assertTrue(browser_required(["docs/fixture.json"]))

    def test_unavailable_git_fails_open(self) -> None:
        """Failure to launch git cannot suppress browser coverage."""
        with patch("scripts.ci_browser_changes.subprocess.check_output", side_effect=OSError):
            self.assertIsNone(changed_paths("a" * 40))

    def test_missing_history_writes_fail_open_output(self) -> None:
        """The actual Actions output remains true if classification has no usable diff."""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "github-output"
            environment = {
                "GITHUB_EVENT_NAME": "pull_request", "OI_PR_BASE_SHA": "a" * 40,
                "OI_PUSH_BEFORE_SHA": "b" * 40, "GITHUB_OUTPUT": str(output),
            }
            with patch.dict(os.environ, environment, clear=True), patch(
                "scripts.ci_browser_changes.changed_paths", return_value=None,
            ) as diff, redirect_stdout(io.StringIO()):
                main()
            diff.assert_called_once_with("a" * 40)
            self.assertEqual(output.read_text(encoding="utf-8"), "browser=true\n")


class BrowserGitDiffTests(unittest.TestCase):
    """Exercise rename and history semantics using real git rather than mocked paths."""

    def setUp(self) -> None:
        """Create an isolated repository with one documentation and one source file."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "--quiet")
        (self.root / "docs").mkdir()
        (self.root / "src").mkdir()
        (self.root / "docs" / "guide.md").write_text("documentation\n", encoding="utf-8")
        (self.root / "src" / "client.ts").write_text("export const value = 1;\n", encoding="utf-8")
        self.commit()
        self.base = self.git("rev-parse", "HEAD")

    def git(self, *arguments: str) -> str:
        """Run git in the test worktree without depending on global identity settings."""
        return subprocess.check_output(
            ["git", "-c", "user.name=CI Test", "-c", "user.email=ci@example.invalid", *arguments],
            cwd=self.root, stderr=subprocess.PIPE, text=True,
        ).strip()

    def commit(self) -> None:
        """Commit the current fixture state so changed_paths compares real revisions."""
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", "test fixture")

    def test_documentation_to_source_rename_triggers(self) -> None:
        """Renaming identical bytes into executable source includes the destination."""
        self.git("mv", "docs/guide.md", "src/guide.ts")
        self.commit()
        paths = changed_paths(self.base, cwd=self.root)
        self.assertCountEqual(paths or [], ["docs/guide.md", "src/guide.ts"])
        self.assertTrue(browser_required(paths or []))

    def test_source_to_documentation_rename_triggers(self) -> None:
        """Renaming source into docs still tests the removed source path."""
        self.git("mv", "src/client.ts", "docs/client.md")
        self.commit()
        paths = changed_paths(self.base, cwd=self.root)
        self.assertCountEqual(paths or [], ["src/client.ts", "docs/client.md"])
        self.assertTrue(browser_required(paths or []))

    def test_documentation_rename_skips(self) -> None:
        """A genuine documentation-only rename remains skippable."""
        self.git("mv", "docs/guide.md", "docs/new guide.md")
        self.commit()
        paths = changed_paths(self.base, cwd=self.root)
        self.assertCountEqual(paths or [], ["docs/guide.md", "docs/new guide.md"])
        self.assertFalse(browser_required(paths or []))

    def test_valid_but_absent_base_fails_open(self) -> None:
        """A syntactically valid SHA absent from a shallow checkout cannot skip CI."""
        self.assertIsNone(changed_paths("a" * 40, cwd=self.root))

    def test_empty_real_diff_fails_open(self) -> None:
        """No changed paths is uncertain, even when git itself succeeds."""
        paths = changed_paths(self.base, cwd=self.root)
        self.assertEqual(paths, [])
        self.assertTrue(browser_required(paths or []))


if __name__ == "__main__":
    unittest.main()
