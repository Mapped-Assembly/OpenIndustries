"""Regression tests ensuring shared code never silently skips browser CI."""
from __future__ import annotations

import unittest

from scripts.ci_browser_changes import browser_required, changed_paths, is_documentation_only


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


if __name__ == "__main__":
    unittest.main()
